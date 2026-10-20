// Implementação WASAPI. Não foi executada em hardware ainda: o CI (windows-latest) compila e roda o modo simulado;
// a captura real é validada na fase 2 (PC Windows). Ver native/win/README.md.
#ifdef _WIN32

#include "windows_platform.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <tlhelp32.h>
#include <propkeydef.h>  // DEFINE_PROPERTYKEY: tem de vir antes de functiondiscoverykeys_devpkey.h
#include <propsys.h>
#include <functiondiscoverykeys_devpkey.h>
#include <wrl/client.h>
#include <wrl/implements.h>

#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <functional>
#include <future>
#include <map>
#include <mutex>
#include <thread>
#include <vector>

#include "../exclude_target.hpp"
#include "../mic_device.hpp"
#include "../output_classify.hpp"

using Microsoft::WRL::ComPtr;

// PKEY_AudioEndpoint_FormFactor ({1DA5D803-D492-4EDD-8C23-E0C0FFEE7F0E}, 0): definido aqui para não depender de INITGUID.
static const PROPERTYKEY kFormFactorKey = {{0x1da5d803, 0xd492, 0x4edd, {0x8c, 0x23, 0xe0, 0xc0, 0xff, 0xee, 0x7f, 0x0e}}, 0};

namespace rice {

namespace {

std::string toUtf8(const wchar_t* w) {
  if (!w || !*w) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(n > 0 ? n - 1 : 0), '\0');
  if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, out.data(), n, nullptr, nullptr);
  return out;
}

std::string hr(HRESULT code) {
  char buf[32];
  std::snprintf(buf, sizeof buf, "0x%08lX", static_cast<unsigned long>(code));
  return buf;
}

std::wstring toWide(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  std::wstring out(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), n);
  return out;
}

std::string endpointId(IMMDevice* device) {
  LPWSTR raw = nullptr;
  if (!device || FAILED(device->GetId(&raw)) || !raw) return {};
  std::string id = toUtf8(raw);
  CoTaskMemFree(raw);
  return id;
}

std::string friendlyName(IMMDevice* device) {
  ComPtr<IPropertyStore> props;
  std::string name;
  if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &props))) {
    PROPVARIANT v;
    PropVariantInit(&v);
    if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR) name = toUtf8(v.pwszVal);
    PropVariantClear(&v);
  }
  return name;
}

/// Entradas (microfones) ativas, com a marcação do padrão (eConsole). Precisa de COM inicializado na thread.
std::vector<InputDevice> activeInputs() {
  std::vector<InputDevice> out;
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)))) return out;
  std::string defaultId;
  ComPtr<IMMDevice> def;
  if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eCapture, eConsole, &def))) defaultId = endpointId(def.Get());
  ComPtr<IMMDeviceCollection> collection;
  if (FAILED(enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &collection))) return out;
  UINT count = 0;
  collection->GetCount(&count);
  for (UINT i = 0; i < count; i++) {
    ComPtr<IMMDevice> device;
    if (FAILED(collection->Item(i, &device))) continue;
    InputDevice d;
    d.id = endpointId(device.Get());
    if (d.id.empty()) continue;
    d.name = friendlyName(device.Get());
    d.isDefault = d.id == defaultId;
    out.push_back(std::move(d));
  }
  return out;
}

/// Chave de privacidade do Windows: "Deny" em HKCU...\ConsentStore\microphone (ou em NonPackaged) = apps de desktop sem mic.
bool microphoneDeniedBySettings() {
  const wchar_t* paths[] = {
      L"Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone",
      L"Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged",
  };
  for (const wchar_t* path : paths) {
    HKEY key = nullptr;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, path, 0, KEY_READ, &key) != ERROR_SUCCESS) continue;
    wchar_t value[16] = {};
    DWORD size = sizeof(value) - sizeof(wchar_t), type = 0;
    LONG rc = RegQueryValueExW(key, L"Value", nullptr, &type, reinterpret_cast<LPBYTE>(value), &size);
    RegCloseKey(key);
    if (rc == ERROR_SUCCESS && type == REG_SZ && _wcsicmp(value, L"Deny") == 0) return true;
  }
  return false;
}

/// Converte o buffer do WASAPI (float32, PCM 16/24/32 bits) para float intercalado.
bool toFloat(const BYTE* data, UINT32 frames, const WAVEFORMATEX* fmt, bool silent, std::vector<float>& out) {
  const size_t count = static_cast<size_t>(frames) * fmt->nChannels;
  out.assign(count, 0.0f);
  if (silent || !data) return true;
  WORD tag = fmt->wFormatTag;
  GUID sub = {};
  if (tag == WAVE_FORMAT_EXTENSIBLE) sub = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(fmt)->SubFormat;
  const bool isFloat = tag == WAVE_FORMAT_IEEE_FLOAT || (tag == WAVE_FORMAT_EXTENSIBLE && IsEqualGUID(sub, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT));
  const bool isPcm = tag == WAVE_FORMAT_PCM || (tag == WAVE_FORMAT_EXTENSIBLE && IsEqualGUID(sub, KSDATAFORMAT_SUBTYPE_PCM));
  if (isFloat && fmt->wBitsPerSample == 32) {
    std::memcpy(out.data(), data, count * sizeof(float));
  } else if (isPcm && fmt->wBitsPerSample == 16) {
    const int16_t* p = reinterpret_cast<const int16_t*>(data);
    for (size_t i = 0; i < count; i++) out[i] = static_cast<float>(p[i]) / 32768.0f;
  } else if (isPcm && fmt->wBitsPerSample == 24) {
    for (size_t i = 0; i < count; i++) {
      int32_t v = static_cast<int32_t>((static_cast<uint32_t>(data[3 * i]) << 8) | (static_cast<uint32_t>(data[3 * i + 1]) << 16) | (static_cast<uint32_t>(data[3 * i + 2]) << 24));
      out[i] = static_cast<float>(v) / 2147483648.0f;
    }
  } else if (isPcm && fmt->wBitsPerSample == 32) {
    const int32_t* p = reinterpret_cast<const int32_t*>(data);
    for (size_t i = 0; i < count; i++) out[i] = static_cast<float>(p[i]) / 2147483648.0f;
  } else {
    return false;
  }
  return true;
}

/// Processos em execução (pid, pai, executável) para achar a raiz da árvore a excluir.
std::vector<ProcessEntry> runningProcesses() {
  std::vector<ProcessEntry> out;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return out;
  PROCESSENTRY32W e = {};
  e.dwSize = sizeof e;
  for (BOOL ok = Process32FirstW(snap, &e); ok; ok = Process32NextW(snap, &e)) {
    out.push_back({static_cast<long>(e.th32ProcessID), static_cast<long>(e.th32ParentProcessID), toUtf8(e.szExeFile)});
  }
  CloseHandle(snap);
  return out;
}

/// Completa o ActivateAudioInterfaceAsync (o Windows chama numa thread dele; precisa ser ágil, daí o FtmBase).
class ActivationHandler final : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, Microsoft::WRL::FtmBase, IActivateAudioInterfaceCompletionHandler> {
 public:
  ActivationHandler() : done(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
  ~ActivationHandler() override { if (done) CloseHandle(done); }
  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation*) override {
    SetEvent(done);
    return S_OK;
  }
  HANDLE done;
};

// ---- Notificações de dispositivo -------------------------------------------------------------------------------

/// Recebe OnDefaultDeviceChanged numa thread do COM e repassa a uma thread própria (nada pesado dentro do callback).
class DeviceMonitor final : public IMMNotificationClient {
 public:
  enum Flow { Capture = 0, Render = 1, CaptureDevices = 2 };  // CaptureDevices: entrou/saiu/mudou de estado qualquer entrada
  using Listener = std::function<void()>;

  static DeviceMonitor& instance() {
    static DeviceMonitor* m = new DeviceMonitor();  // vive até o processo acabar
    return *m;
  }

  int subscribe(Flow flow, Listener l) {
    std::lock_guard<std::mutex> lock(mutex_);
    int id = ++next_;
    listeners_[id] = {flow, std::move(l)};
    return id;
  }
  void unsubscribe(int id) {
    std::lock_guard<std::mutex> lock(mutex_);
    listeners_.erase(id);
  }

  // IUnknown
  ULONG STDMETHODCALLTYPE AddRef() override { return 1; }
  ULONG STDMETHODCALLTYPE Release() override { return 1; }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
    if (iid == __uuidof(IUnknown) || iid == __uuidof(IMMNotificationClient)) {
      *out = static_cast<IMMNotificationClient*>(this);
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  // IMMNotificationClient
  HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow flow, ERole role, LPCWSTR) override {
    if (role == eConsole) post(flow == eCapture ? Capture : Render);
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR, DWORD) override { post(CaptureDevices); return S_OK; }  // trocas do padrão chegam em OnDefaultDeviceChanged
  HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) override { post(CaptureDevices); return S_OK; }
  HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR) override { post(CaptureDevices); return S_OK; }
  HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) override { return S_OK; }

 private:
  DeviceMonitor() {
    worker_ = std::thread([this] { run(); });
    std::thread([this] {
      CoInitializeEx(nullptr, COINIT_MULTITHREADED);
      ComPtr<IMMDeviceEnumerator> en;
      if (SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en)))) {
        en->RegisterEndpointNotificationCallback(this);
        std::unique_lock<std::mutex> lock(mutex_);
        keepAlive_.wait(lock, [] { return false; });  // mantém o enumerador (e o registro) vivos
      }
    }).detach();
  }

  void post(Flow flow) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      pending_[flow] = true;
    }
    wake_.notify_one();
  }

  void run() {
    std::unique_lock<std::mutex> lock(mutex_);
    for (;;) {
      wake_.wait(lock, [this] { return pending_[0] || pending_[1] || pending_[2]; });
      for (int flow = 0; flow < 3; flow++) {
        if (!pending_[flow]) continue;
        pending_[flow] = false;
        std::vector<Listener> toCall;
        for (auto& [id, entry] : listeners_) {
          if (entry.first == flow) toCall.push_back(entry.second);
        }
        lock.unlock();
        for (auto& l : toCall) l();
        lock.lock();
      }
    }
  }

  std::mutex mutex_;
  std::condition_variable wake_, keepAlive_;
  std::map<int, std::pair<Flow, Listener>> listeners_;
  bool pending_[3] = {false, false, false};
  int next_ = 0;
  std::thread worker_;
};

// ---- Captura -----------------------------------------------------------------------------------------------------

class WasapiCapture final : public CaptureHandle {
 public:
  enum class Kind { Microphone, Loopback };

  WasapiCapture(Kind kind, BlockCallback onBlock, std::function<void()> onReopened, std::function<void(std::string)> onFatal)
      : kind_(kind), onBlock_(std::move(onBlock)), onReopened_(std::move(onReopened)), onFatal_(std::move(onFatal)) {}

  ~WasapiCapture() override { stop(); }

  /// Só para o loopback: árvore de processos cujo áudio não entra (0 = loopback da saída inteira).
  void excludeProcessTree(DWORD pid) { excludePid_ = pid; }

  /// Só para o microfone: endpoint escolhido (vazio = padrão) e quem recebe cada mudança do dispositivo em uso.
  void configureMic(std::string preferred, std::function<void(const MicDeviceInfo&)> onDevice) {
    preferred_ = std::move(preferred);
    onDevice_ = std::move(onDevice);
  }

  /// Abre o dispositivo e começa a capturar. Em falha devolve false e preenche `error`/`failure`.
  bool start(std::string& error, CaptureFailure& failure) {
    std::promise<bool> opened;
    auto result = opened.get_future();
    DeviceMonitor::Flow flow = kind_ == Kind::Microphone ? DeviceMonitor::Capture : DeviceMonitor::Render;
    subscription_ = DeviceMonitor::instance().subscribe(flow, [this] { restartRequested_ = true; wakeEvent(); });
    // Com microfone escolhido, também reavalia quando QUALQUER entrada entra, sai ou muda de estado (o escolhido some ou volta).
    if (kind_ == Kind::Microphone && !preferred_.empty()) {
      devicesSubscription_ = DeviceMonitor::instance().subscribe(DeviceMonitor::CaptureDevices, [this] { restartRequested_ = true; wakeEvent(); });
    }
    thread_ = std::thread([this, &opened, &error, &failure] { run(opened, error, failure); });
    bool ok = result.wait_for(std::chrono::seconds(8)) == std::future_status::ready && result.get();
    if (!ok) {
      if (error.empty()) error = "tempo esgotado ao abrir o dispositivo de áudio";
      stop();
    }
    return ok;
  }

  void stop() override {
    if (subscription_ >= 0) DeviceMonitor::instance().unsubscribe(subscription_);
    subscription_ = -1;
    if (devicesSubscription_ >= 0) DeviceMonitor::instance().unsubscribe(devicesSubscription_);
    devicesSubscription_ = -1;
    stopping_ = true;
    wakeEvent();
    if (thread_.joinable() && std::this_thread::get_id() != thread_.get_id()) thread_.join();
  }

 private:
  void wakeEvent() {
    std::lock_guard<std::mutex> lock(eventMutex_);
    if (wake_) SetEvent(wake_);
  }

  bool open(std::string& error, CaptureFailure& failure) {
    close();
    if (kind_ == Kind::Loopback && excludePid_ != 0) {
      std::string why;
      if (openProcessLoopback(why)) return true;
      close();
      // linha que não é JSON: o main ignora, mas fica no stderr para diagnóstico
      if (!warnedFallback_) std::fprintf(stderr, "loopback por processo indisponível (%s); capturando a saída inteira\n", why.c_str());
      warnedFallback_ = true;
    }
    ComPtr<IMMDeviceEnumerator> enumerator;
    HRESULT rc = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
    if (FAILED(rc)) { error = "MMDeviceEnumerator " + hr(rc); return false; }
    const bool loopback = kind_ == Kind::Loopback;
    MicChoice choice;
    bool picked = false;
    if (!loopback && !preferred_.empty()) {
      // Microfone escolhido: abre aquele endpoint se ele estiver ativo; senão (desplugado) cai no padrão.
      choice = chooseMic(preferred_, activeInputs());
      if (choice.preferredActive) {
        std::wstring wide = toWide(choice.id);
        picked = SUCCEEDED(enumerator->GetDevice(wide.c_str(), &device_));
      }
    }
    if (!picked) {
      rc = enumerator->GetDefaultAudioEndpoint(loopback ? eRender : eCapture, eConsole, &device_);
      if (FAILED(rc)) { error = std::string(loopback ? "sem dispositivo de saída padrão " : "sem microfone padrão ") + hr(rc); return false; }
    }
    if (!loopback) announceMic();
    rc = device_->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(client_.GetAddressOf()));
    if (FAILED(rc)) {
      if (rc == E_ACCESSDENIED) failure = CaptureFailure::PermissionDenied;
      error = "IAudioClient::Activate " + hr(rc);
      return false;
    }
    WAVEFORMATEX* mix = nullptr;
    rc = client_->GetMixFormat(&mix);
    if (FAILED(rc)) { error = "GetMixFormat " + hr(rc); return false; }
    format_.assign(reinterpret_cast<BYTE*>(mix), reinterpret_cast<BYTE*>(mix) + sizeof(WAVEFORMATEX) + mix->cbSize);
    CoTaskMemFree(mix);
    const WAVEFORMATEX* fmt = reinterpret_cast<const WAVEFORMATEX*>(format_.data());

    // Mic: modo evento (compartilhado). Loopback: polling (loopback + evento não é confiável) e buffer de 200 ms.
    DWORD flags = loopback ? AUDCLNT_STREAMFLAGS_LOOPBACK : AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
    rc = client_->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2'000'000, 0, fmt, nullptr);
    if (FAILED(rc)) {
      if (rc == E_ACCESSDENIED) failure = CaptureFailure::PermissionDenied;
      error = "IAudioClient::Initialize " + hr(rc);
      return false;
    }
    if (!loopback) {
      rc = client_->SetEventHandle(readyEvent());
      if (FAILED(rc)) { error = "SetEventHandle " + hr(rc); return false; }
    }
    rc = client_->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(capture_.GetAddressOf()));
    if (FAILED(rc)) { error = "GetService(IAudioCaptureClient) " + hr(rc); return false; }
    if (loopback && !openSilentRender()) return false;
    rc = client_->Start();
    if (FAILED(rc)) { error = "IAudioClient::Start " + hr(rc); return false; }
    return true;
  }

  /// Loopback por processo (Windows 10 2004+): tudo o que toca, menos a árvore de `excludePid_`. Não depende do
  /// dispositivo de saída (segue o padrão sozinho). Em falha, o chamador volta ao loopback da saída inteira.
  bool openProcessLoopback(std::string& error) {
    AUDIOCLIENT_ACTIVATION_PARAMS params = {};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = excludePid_;
    params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT prop = {};
    prop.vt = VT_BLOB;
    prop.blob.cbSize = sizeof params;
    prop.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
    auto handler = Microsoft::WRL::Make<ActivationHandler>();
    ComPtr<IActivateAudioInterfaceAsyncOperation> op;
    HRESULT rc = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &prop, handler.Get(), &op);
    if (FAILED(rc)) { error = "ActivateAudioInterfaceAsync " + hr(rc); return false; }
    if (WaitForSingleObject(handler->done, 5000) != WAIT_OBJECT_0) { error = "ActivateAudioInterfaceAsync: tempo esgotado"; return false; }
    HRESULT activated = E_FAIL;
    ComPtr<IUnknown> unknown;
    rc = op->GetActivateResult(&activated, &unknown);
    if (FAILED(rc) || FAILED(activated)) { error = "GetActivateResult " + hr(FAILED(rc) ? rc : activated); return false; }
    if (FAILED(unknown.As(&client_))) { error = "IAudioClient (loopback por processo)"; return false; }
    // Sem GetMixFormat aqui (E_NOTIMPL): pede PCM 16 bits 48 kHz estéreo e o Windows converte.
    WAVEFORMATEX fmt = {};
    fmt.wFormatTag = WAVE_FORMAT_PCM;
    fmt.nChannels = 2;
    fmt.nSamplesPerSec = 48000;
    fmt.wBitsPerSample = 16;
    fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample / 8;
    fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
    format_.assign(reinterpret_cast<BYTE*>(&fmt), reinterpret_cast<BYTE*>(&fmt) + sizeof fmt);
    // EVENTCALLBACK é exigido por esse modo; o laço continua por polling (o evento só existe para o Initialize aceitar).
    rc = client_->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, 2'000'000, 0, &fmt, nullptr);
    if (FAILED(rc)) { error = "IAudioClient::Initialize " + hr(rc); return false; }
    rc = client_->SetEventHandle(readyEvent());
    if (FAILED(rc)) { error = "SetEventHandle " + hr(rc); return false; }
    rc = client_->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(capture_.GetAddressOf()));
    if (FAILED(rc)) { error = "GetService(IAudioCaptureClient) " + hr(rc); return false; }
    openSilentRender();
    rc = client_->Start();
    if (FAILED(rc)) { error = "IAudioClient::Start " + hr(rc); return false; }
    return true;
  }

  /// Reavalia a escolha com as entradas de agora e, se o dispositivo em uso mudou, avisa (evento `mic-device`).
  void announceMic() {
    std::vector<InputDevice> inputs = activeInputs();
    MicDeviceInfo info;
    if (tracker_.update(preferred_, inputs, info)) {
      currentMicId_ = info.id;
      if (onDevice_ && !info.id.empty()) onDevice_(info);
    }
  }

  /// Há mudança que exija reabrir? Sem microfone escolhido, qualquer troca do padrão reabre (como sempre foi).
  bool needsReopen() {
    if (kind_ != Kind::Microphone || preferred_.empty()) return true;
    return chooseMic(preferred_, activeInputs()).id != currentMicId_;
  }

  HANDLE readyEvent() { return ready_ ? ready_ : (ready_ = CreateEventW(nullptr, FALSE, FALSE, nullptr)); }

  /// O loopback só entrega pacotes enquanto algo toca. Um fluxo de silêncio na mesma saída mantém o relógio andando
  /// (sem ele, o `sys` ficaria mudo e o chunker teria de remendar com silêncio a cada retomada).
  bool openSilentRender() {
    ComPtr<IMMDeviceEnumerator> enumerator;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)))) return true;
    ComPtr<IMMDevice> out;
    if (FAILED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &out))) return true;
    if (FAILED(out->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(renderClient_.GetAddressOf())))) return true;
    WAVEFORMATEX* mix = nullptr;
    if (FAILED(renderClient_->GetMixFormat(&mix))) { renderClient_.Reset(); return true; }
    HRESULT rc = renderClient_->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 2'000'000, 0, mix, nullptr);
    CoTaskMemFree(mix);
    if (FAILED(rc) || FAILED(renderClient_->GetService(__uuidof(IAudioRenderClient), reinterpret_cast<void**>(renderWriter_.GetAddressOf()))) || FAILED(renderClient_->GetBufferSize(&renderBufferFrames_))) {
      renderClient_.Reset();
      renderWriter_.Reset();
      return true;  // sem o fluxo de silêncio a captura ainda funciona
    }
    renderClient_->Start();
    return true;
  }

  void keepSilentRenderFed() {
    if (!renderClient_ || !renderWriter_) return;
    UINT32 padding = 0;
    if (FAILED(renderClient_->GetCurrentPadding(&padding)) || padding >= renderBufferFrames_) return;
    UINT32 frames = renderBufferFrames_ - padding;
    BYTE* buffer = nullptr;
    if (SUCCEEDED(renderWriter_->GetBuffer(frames, &buffer))) renderWriter_->ReleaseBuffer(frames, AUDCLNT_BUFFERFLAGS_SILENT);
  }

  void close() {
    if (client_) client_->Stop();
    if (renderClient_) renderClient_->Stop();
    capture_.Reset();
    client_.Reset();
    renderWriter_.Reset();
    renderClient_.Reset();
    device_.Reset();
  }

  /// Esvazia os pacotes disponíveis. false = dispositivo invalidado (precisa reabrir).
  bool drain() {
    const WAVEFORMATEX* fmt = reinterpret_cast<const WAVEFORMATEX*>(format_.data());
    for (;;) {
      UINT32 packet = 0;
      HRESULT rc = capture_->GetNextPacketSize(&packet);
      if (FAILED(rc)) return false;
      if (packet == 0) return true;
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      rc = capture_->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(rc)) return false;
      bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
      if (toFloat(data, frames, fmt, silent, scratch_)) {
        onBlock_(scratch_.data(), frames, fmt->nChannels, static_cast<int>(fmt->nSamplesPerSec));
      } else {
        failedFormat_ = true;
      }
      capture_->ReleaseBuffer(frames);
      if (failedFormat_) return true;
    }
  }

  void run(std::promise<bool>& opened, std::string& error, CaptureFailure& failure) {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    bool alive = false;
    {
      std::lock_guard<std::mutex> lock(eventMutex_);
      wake_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    }
    alive = open(error, failure);
    opened.set_value(alive);
    if (!alive) { finish(); return; }

    const bool loopback = kind_ == Kind::Loopback;
    while (!stopping_) {
      bool invalid = restartRequested_.exchange(false);
      if (invalid && !needsReopen()) invalid = false;
      if (!invalid) {
        if (loopback) {
          keepSilentRenderFed();
          WaitForSingleObject(wake_, 10);
        } else {
          HANDLE handles[2] = {ready_, wake_};
          WaitForMultipleObjects(2, handles, FALSE, 100);
        }
        if (stopping_) break;
        if (restartRequested_.exchange(false) && needsReopen()) invalid = true;
        else if (!drain()) invalid = true;
        else if (failedFormat_) { onFatal_("formato de áudio não suportado"); break; }
      }
      if (invalid) {
        bool reopened = false;
        std::string err;
        CaptureFailure f = CaptureFailure::None;
        for (int attempt = 1; attempt <= 3 && !stopping_; attempt++) {
          if (open(err, f)) { reopened = true; break; }
          if (attempt < 3) Sleep(500);
        }
        if (stopping_) break;
        if (!reopened) { onFatal_(err); break; }
        if (onReopened_) onReopened_();
      }
    }
    finish();
  }

  void finish() {
    close();
    {
      std::lock_guard<std::mutex> lock(eventMutex_);
      if (wake_) CloseHandle(wake_);
      wake_ = nullptr;
    }
    if (ready_) CloseHandle(ready_);
    ready_ = nullptr;
    CoUninitialize();
  }

  Kind kind_;
  BlockCallback onBlock_;
  std::function<void()> onReopened_;
  std::function<void(std::string)> onFatal_;
  std::thread thread_;
  std::atomic<bool> stopping_{false};
  std::atomic<bool> restartRequested_{false};
  int subscription_ = -1;
  int devicesSubscription_ = -1;
  std::string preferred_;
  std::function<void(const MicDeviceInfo&)> onDevice_;
  MicDeviceTracker tracker_;
  std::string currentMicId_;
  std::mutex eventMutex_;
  HANDLE wake_ = nullptr;   // pedido de parar/reabrir
  HANDLE ready_ = nullptr;  // dados prontos (só mic)
  ComPtr<IMMDevice> device_;
  ComPtr<IAudioClient> client_;
  ComPtr<IAudioCaptureClient> capture_;
  ComPtr<IAudioClient> renderClient_;
  ComPtr<IAudioRenderClient> renderWriter_;
  UINT32 renderBufferFrames_ = 0;
  std::vector<BYTE> format_;
  std::vector<float> scratch_;
  bool failedFormat_ = false;
  DWORD excludePid_ = 0;
  bool warnedFallback_ = false;
};

// ---- Plataforma ---------------------------------------------------------------------------------------------------

class WindowsPlatform final : public Platform {
 public:
  explicit WindowsPlatform(LineEmitter&) {}

  std::unique_ptr<CaptureHandle> startMic(BlockCallback onBlock, std::function<void()> onDeviceChanged, std::function<void(std::string)> onFatal, std::string& error, CaptureFailure& failure) override {
    if (microphoneDeniedBySettings()) {
      failure = CaptureFailure::PermissionDenied;
      error = "permissão de microfone negada";
      return nullptr;
    }
    auto capture = std::make_unique<WasapiCapture>(WasapiCapture::Kind::Microphone, std::move(onBlock), std::move(onDeviceChanged), std::move(onFatal));
    capture->configureMic(preferred_, micListener_);
    if (!capture->start(error, failure)) return nullptr;
    return capture;
  }

  void setPreferredInput(const std::string& id) override { preferred_ = id; }
  void setMicDeviceListener(std::function<void(const MicDeviceInfo&)> listener) override { micListener_ = std::move(listener); }
  std::vector<InputDevice> listInputs() override {
    HRESULT init = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    std::vector<InputDevice> inputs = activeInputs();
    if (SUCCEEDED(init)) CoUninitialize();
    return inputs;
  }

  std::unique_ptr<CaptureHandle> startSystem(BlockCallback onBlock, std::function<void(std::string)> onStopped, const std::vector<long>& excludePids, std::string& error) override {
    // --exclude-pid: o loopback por processo exclui UMA árvore (a do primeiro pid; ver exclude_target.hpp).
    CaptureFailure failure = CaptureFailure::None;
    auto capture = std::make_unique<WasapiCapture>(WasapiCapture::Kind::Loopback, std::move(onBlock), nullptr, std::move(onStopped));
    if (!excludePids.empty()) capture->excludeProcessTree(static_cast<DWORD>(excludeTreeRoot(excludePids, runningProcesses())));
    if (!capture->start(error, failure)) return nullptr;
    return capture;
  }

  OutputInfo currentOutput() override {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    ComPtr<IMMDeviceEnumerator> enumerator;
    ComPtr<IMMDevice> device;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator))) ||
        FAILED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device))) {
      OutputInfo none;
      none.name = "?";
      none.reason = "sem saída padrão";
      return none;
    }
    ComPtr<IPropertyStore> props;
    std::string name;
    int form = -1;
    bool bluetooth = false;
    if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &props))) {
      PROPVARIANT v;
      PropVariantInit(&v);
      if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR) name = toUtf8(v.pwszVal);
      PropVariantClear(&v);
      if (SUCCEEDED(props->GetValue(kFormFactorKey, &v)) && v.vt == VT_UI4) form = static_cast<int>(v.ulVal);
      PropVariantClear(&v);
      // Bluetooth: o id do endpoint do fone costuma vir de BTHENUM/BTHHFENUM; o nome amigável também diz "Bluetooth".
      if (SUCCEEDED(props->GetValue(PKEY_Device_EnumeratorName, &v)) && v.vt == VT_LPWSTR) {
        std::wstring e = v.pwszVal;
        bluetooth = e.find(L"BTH") == 0;
      }
      PropVariantClear(&v);
    }
    if (name.find("Bluetooth") != std::string::npos) bluetooth = true;
    return classifyOutput(name, form, bluetooth);
  }

  std::function<void()> observeOutput(std::function<void()> handler) override {
    int id = DeviceMonitor::instance().subscribe(DeviceMonitor::Render, std::move(handler));
    return [id] { DeviceMonitor::instance().unsubscribe(id); };
  }

  /// PowerRequest vale para o processo (não depende da thread, ao contrário de SetThreadExecutionState).
  bool preventSleep(std::string& warning) override {
    REASON_CONTEXT context = {};
    context.Version = POWER_REQUEST_CONTEXT_VERSION;
    context.Flags = POWER_REQUEST_CONTEXT_SIMPLE_STRING;
    static wchar_t reason[] = L"Rice está gravando uma reunião";
    context.Reason.SimpleReasonString = reason;
    power_ = PowerCreateRequest(&context);
    if (power_ == INVALID_HANDLE_VALUE || !PowerSetRequest(power_, PowerRequestSystemRequired)) {
      warning = "não foi possível impedir o repouso (" + std::to_string(GetLastError()) + ")";
      if (power_ != INVALID_HANDLE_VALUE) CloseHandle(power_);
      power_ = INVALID_HANDLE_VALUE;
      return false;
    }
    return true;
  }

  void allowSleep() override {
    if (power_ == INVALID_HANDLE_VALUE) return;
    PowerClearRequest(power_, PowerRequestSystemRequired);
    CloseHandle(power_);
    power_ = INVALID_HANDLE_VALUE;
  }

 private:
  HANDLE power_ = INVALID_HANDLE_VALUE;
  std::string preferred_;
  std::function<void(const MicDeviceInfo&)> micListener_;
};

}  // namespace

std::unique_ptr<Platform> makeWindowsPlatform(LineEmitter& events) { return std::make_unique<WindowsPlatform>(events); }

}  // namespace rice

#endif  // _WIN32
