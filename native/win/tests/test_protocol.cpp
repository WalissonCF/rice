// Paridade com o Swift: tudo aqui compara com fixtures gravados do rice-audio/rice-detector de macOS.
#include <algorithm>
#include <cmath>
#include <random>
#include <map>
#include <thread>

#include "../audio/echo_canceller.hpp"
#include "../audio/exclude_target.hpp"
#include "../audio/mic_device.hpp"
#include "../audio/output_classify.hpp"
#include "../audio/recorder.hpp"
#include "../audio/selftests.hpp"
#include "../audio/simulated_platform.hpp"
#include "../audio/sinks.hpp"
#include "../common/framing.hpp"
#include "../common/json.hpp"
#include "../detector/app_matcher.hpp"
#include "../detector/mic_monitor.hpp"
#include "../detector/mic_watcher.hpp"
#include "../detector/window_list.hpp"
#include "check.hpp"
#include "fixtures.hpp"

using namespace rice;

namespace {

struct Capture {
  std::vector<std::string> lines;
  LineEmitter emitter{[this](const std::string& l) { lines.push_back(l); }};
};

std::vector<DecodedFrame> decode(const std::vector<uint8_t>& bytes) {
  FrameDecoder d;
  auto frames = d.push(bytes.data(), bytes.size());
  CHECK(!d.failed());
  CHECK_EQ(d.pendingBytes(), static_cast<size_t>(0));
  return frames;
}

std::vector<DecodedFrame> ofSource(const std::vector<DecodedFrame>& all, Source s) {
  std::vector<DecodedFrame> out;
  for (const auto& f : all) {
    if (f.source == s) out.push_back(f);
  }
  return out;
}

std::vector<int16_t> samplesOf(const std::vector<DecodedFrame>& frames) {
  std::vector<int16_t> out;
  for (const auto& f : frames) out.insert(out.end(), f.pcm.begin(), f.pcm.end());
  return out;
}

double rms(const std::vector<int16_t>& s, size_t from = 0, size_t to = SIZE_MAX) {
  to = std::min(to, s.size());
  double sum = 0;
  for (size_t i = from; i < to; i++) sum += static_cast<double>(s[i]) * s[i];
  return std::sqrt(sum / static_cast<double>(to - from));
}

std::vector<uint8_t> toBytes(const MemoryFrameSink& sink) {
  std::vector<uint8_t> out;
  for (const auto& e : sink.entries()) {
    auto f = encodeFrame(e.source, e.timestampMs, e.pcm.data(), e.pcm.size());
    out.insert(out.end(), f.begin(), f.end());
  }
  return out;
}

}  // namespace

TEST(json_serializa_como_o_foundation_com_sortedKeys) {
  json::Value v = json::Value::object();
  v.set("source", "mic").set("ms", 1000).set("a/b", "x\"y\\z\n");
  CHECK_EQ(v.dump(), std::string(R"({"a\/b":"x\"y\\z\n","ms":1000,"source":"mic"})"));
  json::Value n = json::Value::object();
  n.set("app", nullptr).set("ok", true).set("list", json::Value::array().push(1).push("a"));
  CHECK_EQ(n.dump(), std::string(R"({"app":null,"list":[1,"a"],"ok":true})"));
}

TEST(json_le_comandos_e_rejeita_lixo) {
  auto c = json::parseCommand(R"({"cmd":"complete-reminder","id":"aç😀"})");
  CHECK(c.has_value());
  CHECK_EQ(c->name, std::string("complete-reminder"));
  CHECK_EQ(c->body.getString("id"), std::string("a\xc3\xa7\xf0\x9f\x98\x80"));
  CHECK(!json::parseCommand("lixo").has_value());
  CHECK(!json::parseCommand("[1]").has_value());
  CHECK(!json::parseCommand(R"({"cmd":1})").has_value());
  CHECK(!json::parseCommand(R"({"cmd":"x"} x)").has_value());
  CHECK(json::parseCommand(R"({"cmd":"list-events","from":"2026-10-11T10:00:00.000Z"})").has_value());
}

TEST(framing_ida_e_volta_com_pedacos_arbitrarios) {
  int16_t pcm[4] = {1, -2, 300, -32768};
  auto bytes = encodeFrame(Source::Sys, 0x0102030405ULL, pcm, 4);
  CHECK_EQ(bytes.size(), kFrameHeaderBytes + 8);
  CHECK_EQ(bytes[0], static_cast<uint8_t>(2));
  CHECK_EQ(bytes[1], static_cast<uint8_t>(0x05));
  CHECK_EQ(bytes[9], static_cast<uint8_t>(8));
  FrameDecoder d;
  std::vector<DecodedFrame> all;
  for (size_t i = 0; i < bytes.size(); i++) {
    auto part = d.push(&bytes[i], 1);
    all.insert(all.end(), part.begin(), part.end());
  }
  CHECK_EQ(all.size(), static_cast<size_t>(1));
  CHECK_EQ(all[0].timestampMs, static_cast<uint64_t>(0x0102030405ULL));
  CHECK_EQ(all[0].pcm[3], static_cast<int16_t>(-32768));
  uint8_t bad[13] = {7};
  FrameDecoder d2;
  d2.push(bad, 13);
  CHECK(d2.failed());
}

TEST(selftest_gap_e_identico_bit_a_bit_ao_do_swift) {
  Capture cap;
  MemoryFrameSink sink;
  runGapSelfTest(sink, cap.emitter);
  CHECK(toBytes(sink) == readFixture("protocol/gap.bin"));
  CHECK_EQ(cap.lines.size(), static_cast<size_t>(1));
  std::string expected = readFixtureText("protocol/gap.stderr");
  while (!expected.empty() && (expected.back() == '\n' || expected.back() == '\r')) expected.pop_back();
  CHECK_EQ(cap.lines.empty() ? std::string() : cap.lines[0], expected);
}

TEST(selftest_tone_tem_a_mesma_estrutura_e_sinal_do_swift) {
  Capture cap;
  MemoryFrameSink sink;
  runToneSelfTest(sink, cap.emitter);
  CHECK(cap.lines.empty());
  auto mine = decode(toBytes(sink));
  auto swift = decode(readFixture("protocol/tone.bin"));
  for (Source s : {Source::Mic, Source::Sys}) {
    auto a = ofSource(mine, s), b = ofSource(swift, s);
    CHECK(a.size() >= 9 && a.size() <= 10);
    CHECK_EQ(a.size(), b.size());
    for (size_t i = 0; i < a.size(); i++) {
      CHECK_EQ(a[i].timestampMs, static_cast<uint64_t>(i * 100));  // 100 ms por frame
      if (i + 1 < a.size()) CHECK_EQ(a[i].pcm.size(), static_cast<size_t>(1600));
    }
    // Os dois resamplers devem produzir o mesmo sinal: compara amostra a amostra, ignorando o início (aquecimento do filtro)
    // e o final (o Swift perde ~260 amostras, o nosso não).
    auto x = samplesOf(a), y = samplesOf(b);
    size_t n = std::min(x.size(), y.size()) - 200;
    int maxDiff = 0;
    for (size_t i = 100; i < n; i++) maxDiff = std::max(maxDiff, std::abs(x[i] - y[i]));
    std::fprintf(stderr, "  %s: maxDiff=%d rms=%.0f (swift %.0f)\n", sourceName(s), maxDiff, rms(x), rms(y));
    CHECK(maxDiff < 330);  // 1% do fundo de escala
    CHECK(std::fabs(rms(x) - 11585) < 400);
    CHECK(*std::max_element(x.begin(), x.end()) < 32767);
  }
}

TEST(resampler_mantem_estado_entre_blocos_e_aceita_outras_taxas) {
  // 44,1 kHz mono, 1 s em blocos irregulares: ~16000 saídas e a mesma frequência.
  Resampler r;
  std::vector<int16_t> out;
  size_t pos = 0;
  const size_t total = 44100;
  const size_t sizes[] = {441, 1000, 333, 4096};
  for (size_t k = 0; pos < total; k++) {
    size_t n = std::min(sizes[k % 4], total - pos);
    std::vector<float> block(n);
    for (size_t i = 0; i < n; i++) block[i] = static_cast<float>(0.5 * std::sin(2 * 3.14159265358979 * 1000 * static_cast<double>(pos + i) / 44100));
    auto part = r.convert(block.data(), n, 1, 44100);
    out.insert(out.end(), part.begin(), part.end());
    pos += n;
  }
  CHECK(out.size() > 15900 && out.size() <= 16000);
  int crossings = 0;
  for (size_t i = 101; i < out.size(); i++) crossings += (out[i - 1] < 0) != (out[i] < 0);
  double hz = crossings / 2.0 / (static_cast<double>(out.size() - 100) / 16000);
  CHECK(std::fabs(hz - 1000) < 15);
  // Mudar o formato no meio recria o estado sem travar.
  float stereo[960] = {};
  CHECK(r.convert(stereo, 480, 2, 48000).size() <= 160);
}

TEST(chunker_insere_silencio_so_acima_de_200ms) {
  Capture cap;
  MemoryFrameSink sink;
  Chunker c(Source::Mic, sink, cap.emitter);
  std::vector<int16_t> block(1600, 7);
  c.append(block, 100);
  c.append(block, 300);  // 100 ms de atraso: dentro da tolerância
  CHECK(cap.lines.empty());
  c.append(block, 900);  // 600 ms além do esperado
  CHECK_EQ(cap.lines.size(), static_cast<size_t>(1));
  CHECK_EQ(cap.lines[0], std::string(R"({"event":"gap","ms":600,"source":"mic"})"));
  c.flush();
  size_t total = 0;
  for (auto& e : sink.entries()) total += e.pcm.size();
  CHECK_EQ(total, static_cast<size_t>(1600 * 3 + 600 * 16));
}

TEST(app_matcher_segue_a_tabela_do_swift) {
  auto doc = json::parse(readFixtureText("protocol/detector.json"));
  CHECK(doc.has_value());
  for (const auto& item : doc->get("match")->items()) {
    auto app = matchApp(item.get("input")->str());
    const json::Value* expected = item.get("output")->get("app");
    if (expected->isNull()) CHECK(!app.has_value());
    else CHECK_EQ(app.value_or("(nenhum)"), expected->str());
  }
}

TEST(mic_watcher_gera_os_mesmos_eventos_do_swift) {
  auto doc = json::parse(readFixtureText("protocol/detector.json"));
  for (const auto& item : doc->get("simulateMic")->items()) {
    Capture cap;
    MicWatcher watcher(cap.emitter);
    for (const auto& step : item.get("input")->items()) {
      std::vector<std::string> ids;
      for (const auto& id : step.items()) ids.push_back(id.str());
      watcher.tick(ids);
    }
    const auto& expected = item.get("output")->items();
    CHECK_EQ(cap.lines.size(), expected.size());
    for (size_t i = 0; i < expected.size() && i < cap.lines.size(); i++) CHECK_EQ(cap.lines[i], expected[i].dump());
  }
}

TEST(app_matcher_windows_e_chaves_do_registro) {
  CHECK_EQ(matchApp("Zoom.exe").value_or(""), std::string("Zoom"));
  CHECK_EQ(matchApp("ms-teams.exe").value_or(""), std::string("Microsoft Teams"));
  CHECK_EQ(matchApp("MSTeams_8wekyb3d8bbwe").value_or(""), std::string("Microsoft Teams"));
  CHECK_EQ(matchApp("chrome.exe").value_or(""), std::string("Google Chrome"));
  CHECK_EQ(matchApp("MSEDGE.EXE").value_or(""), std::string("Microsoft Edge"));
  CHECK(!matchApp("RiceApp.exe").has_value());
  CHECK(!matchApp("notchrome.exe").has_value());
  CHECK_EQ(executableFromConsentKey("C:#Program Files#Google#Chrome#Application#chrome.exe"), std::string("chrome.exe"));
  CHECK_EQ(executableFromConsentKey("MSTeams_8wekyb3d8bbwe"), std::string("MSTeams_8wekyb3d8bbwe"));
}

TEST(app_matcher_cobre_os_apps_de_reuniao_do_windows) {
  struct Case { const char* id; const char* app; };
  const Case cases[] = {
      {"Zoom.exe", "Zoom"}, {"ms-teams.exe", "Microsoft Teams"}, {"Teams.exe", "Microsoft Teams"},
      {"MSTeams_8wekyb3d8bbwe", "Microsoft Teams"}, {"chrome.exe", "Google Chrome"}, {"chrome_proxy.exe", "Google Chrome"},
      {"msedge.exe", "Microsoft Edge"}, {"msedge_proxy.exe", "Microsoft Edge"}, {"firefox.exe", "Firefox"}, {"brave.exe", "Brave"},
      {"slack.exe", "Slack"}, {"Discord.exe", "Discord"}, {"DiscordCanary.exe", "Discord"}, {"DiscordPTB.exe", "Discord"},
      {"CiscoCollabHost.exe", "Webex"}, {"Webex.exe", "Webex"}, {"webexmta.exe", "Webex"}, {"Whereby.exe", "Whereby"},
  };
  for (const auto& c : cases) CHECK_EQ(matchApp(c.id).value_or("(nenhum)"), std::string(c.app));
  // Não é reunião: o runtime de WebView (usado por muitos apps), outros navegadores/apps e nomes parecidos.
  for (const char* id : {"msedgewebview2.exe", "Teamsnot.exe", "zoomies.exe", "discordbot.exe", "explorer.exe"}) CHECK(!matchApp(id).has_value());
  // Um navegador sem o microfone em uso nunca vira reunião: o watcher só enxerga quem usa o mic.
  Capture quiet;
  MicWatcher idle(quiet.emitter);
  idle.tick({});
  CHECK(quiet.lines.empty());
  // Chrome e seu proxy de PWA (Meet instalado) são o mesmo app: um só mic-in-use.
  Capture pwa;
  MicWatcher watcher(pwa.emitter);
  watcher.tick({"chrome.exe", "chrome_proxy.exe"});
  CHECK_EQ(pwa.lines.size(), static_cast<size_t>(1));
}

namespace {
WindowInfo makeWindow(long long hwnd, unsigned long pid, const char* exe, const char* title, int x, int y, int w, int h) {
  WindowInfo info;
  info.hwnd = hwnd; info.pid = pid; info.exe = exe; info.title = title;
  info.x = x; info.y = y; info.w = w; info.h = h;
  info.monitor = x >= 1920 ? 2 : 1; info.mx = x >= 1920 ? 1920 : 0; info.my = 0; info.mw = x >= 1920 ? 2560 : 1920; info.mh = x >= 1920 ? 1440 : 1080;
  return info;
}
}  // namespace

TEST(lista_de_janelas_filtra_por_app_exe_e_pid_mantendo_a_ordem) {
  std::vector<WindowInfo> all = {
      makeWindow(10, 100, "chrome.exe", "Meet - abc-defg-hij - Google Chrome", 100, 100, 1400, 900),
      makeWindow(11, 200, "Code.exe", "main.cpp", 0, 0, 800, 600),
      makeWindow(12, 300, "Zoom.exe", "Zoom Meeting", 2000, 50, 1280, 720),
      makeWindow(13, 100, "chrome.exe", "Docs", 50, 50, 1000, 700),
  };
  CHECK_EQ(filterWindows(all, {}).size(), static_cast<size_t>(4));
  WindowFilter byApp;
  byApp.apps = {"Google Chrome"};
  auto chrome = filterWindows(all, byApp);
  CHECK_EQ(chrome.size(), static_cast<size_t>(2));
  CHECK_EQ(chrome[0].hwnd, 10LL);
  CHECK_EQ(chrome[1].hwnd, 13LL);
  WindowFilter byExe;
  byExe.exes = {"ZOOM.EXE"};
  CHECK_EQ(filterWindows(all, byExe).size(), static_cast<size_t>(1));
  WindowFilter byPid;
  byPid.pids = {200};
  CHECK_EQ(filterWindows(all, byPid)[0].exe, std::string("Code.exe"));
  WindowFilter none;
  none.apps = {"Slack"};
  CHECK(filterWindows(all, none).empty());
}

TEST(lista_de_janelas_json_ida_e_volta_no_formato_que_o_rice_le) {
  std::vector<WindowInfo> all = {makeWindow(12, 300, "Zoom.exe", "Zoom \"Reunião\"", 2000, 50, 1280, 720), makeWindow(7, 5, "Code.exe", "x", 0, 0, 10, 10)};
  json::Value list = windowsToJson(all);
  const json::Value& first = list.items()[0];
  CHECK_EQ(first.getString("owner"), std::string("Zoom"));  // nome do app, como o detector emite
  CHECK_EQ(list.items()[1].getString("owner"), std::string("Code"));  // sem match: o .exe sem extensão
  CHECK_EQ(first.get("id")->integer(), 12LL);
  CHECK_EQ(first.get("pid")->integer(), 300LL);
  CHECK_EQ(first.get("x")->integer(), 2000LL);
  CHECK_EQ(first.get("monitor")->integer(), 2LL);
  CHECK_EQ(first.get("mw")->integer(), 2560LL);
  auto parsed = json::parse(list.dump());
  CHECK(parsed.has_value());
  auto back = windowsFromJson(*parsed);
  CHECK_EQ(back.size(), static_cast<size_t>(2));
  CHECK_EQ(back[0].title, std::string("Zoom \"Reunião\""));
  CHECK_EQ(back[0].w, 1280);
  CHECK(windowsFromJson(json::Value::object()).empty());
}

namespace {

double energyDb(const std::vector<int16_t>& s, size_t from, size_t to) {
  double sum = 0;
  for (size_t i = from; i < to; i++) sum += static_cast<double>(s[i]) * s[i];
  return 10 * std::log10(sum / static_cast<double>(to - from) + 1e-9);
}

int16_t clamp16(double v) { return static_cast<int16_t>(std::max(-32767.0, std::min(32767.0, v))); }

/// Referência sintética (o "áudio do sistema"): ruído passa-baixa + dois tons, com envelope de fala. Determinística.
std::vector<int16_t> syntheticReference(size_t samples, unsigned seed) {
  std::mt19937_64 gen{seed};
  std::uniform_real_distribution<double> uni(-1, 1);
  std::vector<int16_t> out(samples);
  double lowpass = 0;
  for (size_t i = 0; i < samples; i++) {
    double t = static_cast<double>(i) / 16000;
    double envelope = 0.5 + 0.5 * std::sin(2 * 3.14159265358979 * 3 * t);
    lowpass += 0.3 * (uni(gen) - lowpass);
    double tone = 0.3 * std::sin(2 * 3.14159265358979 * 220 * t) + 0.2 * std::sin(2 * 3.14159265358979 * 660 * t);
    out[i] = clamp16(12000 * envelope * (lowpass + tone));
  }
  return out;
}

/// O que o microfone capta do alto-falante: a referência atrasada e atenuada, mais um segundo caminho (reflexo).
std::vector<int16_t> echoOf(const std::vector<int16_t>& reference, size_t delay, double gain, size_t delay2, double gain2) {
  std::vector<int16_t> mic(reference.size(), 0);
  for (size_t i = 0; i < reference.size(); i++) {
    double v = 0;
    if (i >= delay) v += gain * reference[i - delay];
    if (i >= delay2) v += gain2 * reference[i - delay2];
    mic[i] = clamp16(v);
  }
  return mic;
}

std::vector<int16_t> runThroughAec(EchoCanceller& aec, const std::vector<int16_t>& reference, const std::vector<int16_t>& mic) {
  std::vector<int16_t> output;
  const size_t frame = EchoCanceller::kFrameSamples;
  for (size_t start = 0; start + frame <= mic.size(); start += frame) {
    aec.pushRender(std::vector<int16_t>(reference.begin() + static_cast<std::ptrdiff_t>(start), reference.begin() + static_cast<std::ptrdiff_t>(start + frame)));
    auto cleaned = aec.processCapture(std::vector<int16_t>(mic.begin() + static_cast<std::ptrdiff_t>(start), mic.begin() + static_cast<std::ptrdiff_t>(start + frame)));
    output.insert(output.end(), cleaned.begin(), cleaned.end());
  }
  return output;
}

}  // namespace

TEST(aec_eco_atrasado_da_referencia_perde_energia_e_a_voz_continua) {
  Capture cap;
  auto aec = EchoCanceller::create(cap.emitter);
  if (!EchoCanceller::compiledIn()) {
    // Build sem AEC3: não há o que cancelar, mas a falha é limpa (sem objeto, sem evento) e o selftest avisa em JSON.
    CHECK(aec == nullptr);
    CHECK_EQ(runAecSelfTest(cap.emitter), std::string(R"({"error":"AEC3 não incluído neste build"})"));
    return;
  }
  CHECK(aec != nullptr);
  if (!aec) return;
  const size_t rate = 16000, total = rate * 8;
  auto reference = syntheticReference(total, 12345);
  auto mic = echoOf(reference, 640, 0.5, 960, 0.2);  // eco a 40 ms e 60 ms
  // Voz do usuário (double-talk) entre 5 s e 7 s: tem de sobreviver ao cancelamento.
  std::vector<int16_t> voice(total, 0);
  const size_t voiceStart = rate * 5, voiceEnd = rate * 7;
  for (size_t i = voiceStart; i < voiceEnd; i++) {
    double t = static_cast<double>(i) / rate;
    voice[i] = static_cast<int16_t>(6000 * (0.6 + 0.4 * std::sin(2 * 3.14159265358979 * 4 * t)) * (std::sin(2 * 3.14159265358979 * 300 * t) + 0.5 * std::sin(2 * 3.14159265358979 * 900 * t)));
    mic[i] = clamp16(static_cast<double>(mic[i]) + voice[i]);
  }
  auto output = runThroughAec(*aec, reference, mic);
  CHECK(output.size() >= total - EchoCanceller::kFrameSamples);
  // Só eco (antes da voz): a energia cai pelo menos 15 dB depois da convergência (os últimos 1,5 s antes da voz).
  const size_t from = voiceStart - rate * 3 / 2, to = voiceStart;
  double reduction = energyDb(mic, from, to) - energyDb(output, from, to);
  std::fprintf(stderr, "  aec: eco %.1f dB -> %.1f dB (queda %.1f dB)\n", energyDb(mic, from, to), energyDb(output, from, to), reduction);
  CHECK(reduction >= 15.0);
  // Voz: o AEC não pode comer a fala (perda < 6 dB depois de 100 ms de ataque).
  const size_t vFrom = voiceStart + rate / 10;
  double voiceLoss = energyDb(voice, vFrom, voiceEnd) - energyDb(output, vFrom, voiceEnd);
  std::fprintf(stderr, "  aec: perda de voz %.1f dB\n", voiceLoss);
  CHECK(voiceLoss < 6.0);
  CHECK(cap.lines.empty());  // nenhum aviso de quadro rejeitado
}

TEST(aec_desligado_no_fone_passa_o_microfone_sem_alterar) {
  Capture cap;
  auto aec = EchoCanceller::create(cap.emitter);
  if (!aec) return;  // build sem AEC3 (coberto no teste anterior)
  aec->setEnabled(false);
  CHECK(!aec->isEnabled());
  auto reference = syntheticReference(16000, 7);
  auto mic = echoOf(reference, 640, 0.5, 960, 0.2);
  auto out = runThroughAec(*aec, reference, mic);
  CHECK_EQ(out.size(), mic.size() - mic.size() % EchoCanceller::kFrameSamples);
  CHECK(std::equal(out.begin(), out.end(), mic.begin()));
}

TEST(recorder_avisa_o_estado_do_aec_pelo_evento_aec_do_protocolo) {
  // Com AEC no build: ligado em alto-falante e desligado no fone, com o motivo. Sem AEC: o mesmo evento, "não incluído".
  for (bool headphones : {false, true}) {
    Capture cap;
    MemoryFrameSink sink;
    SimulatedPlatform platform;
    RecorderOptions opt;
    opt.echoCancellation = true;  // sem AEC no build, o Recorder avisa "não incluído"
    platform.setHeadphones(headphones);
    {
      Recorder rec(platform, sink, cap.emitter, opt);
      rec.start();
      platform.setHeadphones(!headphones);  // troca de fone no meio da gravação: o AEC acompanha
      rec.stop();
    }
    std::string all;
    for (auto& l : cap.lines) all += l + "\n";
    if (EchoCanceller::compiledIn()) {
      CHECK(all.find(R"("enabled":false,"event":"aec")") != std::string::npos);  // no fone
      CHECK(all.find(R"("enabled":true,"event":"aec")") != std::string::npos);   // no alto-falante
    } else {
      CHECK(all.find(R"({"enabled":false,"event":"aec","reason":"AEC3 não incluído neste build"})") != std::string::npos);
    }
  }
}

namespace {
InputDevice input(const char* id, const char* name, bool isDefault) { return InputDevice{id, name, isDefault, "active"}; }

std::vector<std::string> micEvents(const std::vector<std::string>& lines) {
  std::vector<std::string> out;
  for (const auto& l : lines) {
    if (l.find(R"("event":"mic-device")") != std::string::npos) out.push_back(l);
  }
  return out;
}
}  // namespace

TEST(mic_escolhido_sem_preferencia_segue_o_padrao_e_so_avisa_quando_muda) {
  MicDeviceTracker t;
  MicDeviceInfo info;
  std::vector<InputDevice> devs = {input("a", "Microfone (Realtek)", true), input("b", "Microfone (FIFINE K669)", false)};
  CHECK(t.update("", devs, info));
  CHECK_EQ(info.id, std::string("a"));
  CHECK_EQ(info.reason, std::string("open"));
  CHECK(info.isDefault);
  CHECK(!t.update("", devs, info));  // nada mudou
  devs[0].isDefault = false;
  devs[1].isDefault = true;  // o usuário trocou o padrão do Windows
  CHECK(t.update("", devs, info));
  CHECK_EQ(info.id, std::string("b"));
  CHECK_EQ(info.reason, std::string("default-changed"));
}

TEST(mic_escolhido_some_cai_no_padrao_e_retoma_quando_volta) {
  MicDeviceTracker t;
  MicDeviceInfo info;
  std::vector<InputDevice> both = {input("a", "Microfone (Realtek)", true), input("b", "Microfone (FIFINE K669)", false)};
  std::vector<InputDevice> onlyA = {input("a", "Microfone (Realtek)", true)};
  CHECK(t.update("b", both, info));
  CHECK_EQ(info.id, std::string("b"));
  CHECK(!info.isDefault);  // escolhido, mas não é o padrão do sistema
  CHECK_EQ(info.reason, std::string("open"));
  CHECK(t.update("b", onlyA, info));  // desplugou
  CHECK_EQ(info.id, std::string("a"));
  CHECK_EQ(info.reason, std::string("preferred-missing"));
  CHECK(!t.update("b", onlyA, info));
  CHECK(t.update("b", both, info));  // voltou
  CHECK_EQ(info.id, std::string("b"));
  CHECK_EQ(info.reason, std::string("preferred-returned"));
  // Escolhido que nunca existiu: padrão desde o início, sem inventar "retomada".
  MicDeviceTracker u;
  CHECK(u.update("zzz", both, info));
  CHECK_EQ(info.id, std::string("a"));
  CHECK(chooseMic("", {}).id.empty());  // nenhuma entrada
}

TEST(recorder_emite_mic_device_ao_abrir_e_a_cada_troca_com_a_plataforma_simulada) {
  Capture cap;
  MemoryFrameSink sink;
  SimulatedPlatform platform;
  platform.setInputs({input("a", "Microfone (Realtek)", true), input("b", "Microfone (FIFINE K669)", false)});
  RecorderOptions opt;
  opt.echoCancellation = false;
  opt.micDevice = "b";
  {
    Recorder rec(platform, sink, cap.emitter, opt);
    rec.start();
    platform.unplugInput("b");
    platform.plugInput(input("b", "Microfone (FIFINE K669)", false));
    platform.setDefaultInput("b");  // escolhido já em uso: o padrão mudar não troca nada
    rec.stop();
  }
  auto ev = micEvents(cap.lines);
  CHECK_EQ(ev.size(), static_cast<size_t>(3));
  auto doc = json::parse(readFixtureText("protocol/mic-device.json"));
  CHECK(doc.has_value());
  if (ev.size() == 3 && doc) {
    const auto& expected = doc->get("events")->items();
    for (size_t i = 0; i < 3; i++) CHECK_EQ(ev[i], expected[i].dump());
  }
}

TEST(recorder_sem_escolha_segue_o_padrao_e_os_eventos_existentes_continuam) {
  Capture cap;
  MemoryFrameSink sink;
  SimulatedPlatform platform;  // uma entrada: sim-default
  RecorderOptions opt;
  opt.echoCancellation = false;
  {
    Recorder rec(platform, sink, cap.emitter, opt);
    rec.start();
    platform.plugInput(input("usb", "Microfone USB", false));
    platform.setDefaultInput("usb");
    rec.stop();
  }
  auto ev = micEvents(cap.lines);
  CHECK_EQ(ev.size(), static_cast<size_t>(2));
  if (ev.size() == 2) {
    CHECK(ev[0].find(R"("reason":"open")") != std::string::npos);
    CHECK(ev[1].find(R"("id":"usb")") != std::string::npos && ev[1].find(R"("reason":"default-changed")") != std::string::npos);
  }
  std::string all;
  for (auto& l : cap.lines) all += l + "\n";
  CHECK(all.find(R"j({"event":"started","mic":true,"sys":true})j") != std::string::npos);
  CHECK(all.find(R"j({"event":"stopped"})j") != std::string::npos);
}

TEST(lista_de_entradas_json_ida_e_volta_e_ignora_lixo) {
  auto fixture = json::parse(readFixtureText("protocol/mic-device.json"));
  CHECK(fixture.has_value());
  if (fixture) {
    auto parsed = inputsFromJson(*fixture->get("inputs"));
    CHECK_EQ(parsed.size(), static_cast<size_t>(2));
    CHECK_EQ(inputsToJson(parsed).dump(), fixture->get("inputs")->dump());  // o que o helper imprime = o que o app lê
  }
  std::vector<InputDevice> devs = {input("{0.0.1.00000000}.{abc}", "Microfone (FIFINE K669)", true), input("{2}", "Mix estéreo", false)};
  std::string text = inputsToJson(devs).dump();
  CHECK_EQ(text, std::string(R"j([{"id":"{0.0.1.00000000}.{abc}","isDefault":true,"name":"Microfone (FIFINE K669)","state":"active"},{"id":"{2}","isDefault":false,"name":"Mix estéreo","state":"active"}])j"));
  auto back = inputsFromJson(*json::parse(text));
  CHECK_EQ(back.size(), static_cast<size_t>(2));
  CHECK(back[0].isDefault);
  CHECK_EQ(back[1].name, std::string("Mix estéreo"));
  CHECK(inputsFromJson(*json::parse(R"([{"name":"sem id"},5,null])")).empty());
}

TEST(classificacao_da_saida_fone_ou_alto_falante) {
  CHECK(classifyOutput("Alto-falantes (Realtek)", 1, false).isHeadphones == false);
  CHECK(classifyOutput("Alto-falantes (Realtek)", 3, false).isHeadphones);
  CHECK(classifyOutput("Qualquer", 1, true).isHeadphones);
  CHECK(classifyOutput("AirPods de Ana", 1, false).isHeadphones);
  CHECK(classifyOutput("Headset (Jabra)", 10, false).isHeadphones);
  CHECK_EQ(classifyOutput("", 1, false).name, std::string("?"));
}

TEST(recorder_simulado_grava_as_duas_fontes_e_emite_os_eventos) {
  Capture cap;
  MemoryFrameSink sink;
  SimulatedPlatform platform;
  RecorderOptions opt;
  opt.echoCancellation = false;
  {
    Recorder rec(platform, sink, cap.emitter, opt);
    rec.start();
    // Espera por conteúdo, não por tempo fixo: runner carregado entrega menos blocos por segundo.
    for (int i = 0; i < 200; i++) {
      size_t mic = 0, sys = 0;
      for (const auto& e : sink.entries()) (e.source == Source::Mic ? mic : sys)++;
      if (mic >= 10 && sys >= 10) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    rec.stop();
    rec.stop();  // idempotente
  }
  std::string all;
  for (auto& l : cap.lines) all += l + "\n";
  CHECK(all.find(R"({"enabled":false,"event":"aec","reason":"desligado por --no-aec"})") != std::string::npos);
  CHECK(all.find(R"({"event":"started","mic":true,"sys":true})") != std::string::npos);
  CHECK(all.find(R"({"event":"stopped"})") != std::string::npos);
  CHECK_EQ(platform.sleepBlocks(), 1);
  CHECK_EQ(platform.sleepReleases(), 1);
  auto frames = decode(toBytes(sink));
  for (Source s : {Source::Mic, Source::Sys}) {
    auto f = ofSource(frames, s);
    CHECK(f.size() >= 10);
    for (size_t i = 1; i < f.size(); i++) CHECK_EQ(f[i].timestampMs - f[i - 1].timestampMs, static_cast<uint64_t>(100));
  }
}

TEST(recorder_start_depois_de_stop_e_ignorado_e_permissao_negada_vira_erro) {
  {
    Capture cap;
    MemoryFrameSink sink;
    SimulatedPlatform platform;
    Recorder rec(platform, sink, cap.emitter, {});
    rec.stop();
    rec.start();
    CHECK(cap.lines.empty());
  }
  Capture cap;
  MemoryFrameSink sink;
  SimulatedPlatform::Script script;
  script.micPermissionDenied = true;
  SimulatedPlatform platform(script);
  RecorderOptions opt;
  opt.echoCancellation = false;
  Recorder rec(platform, sink, cap.emitter, opt);
  rec.start();
  rec.stop();
  std::string all;
  for (auto& l : cap.lines) all += l + "\n";
  CHECK(all.find(R"({"event":"error","message":"permissão de microfone negada","source":"mic"})") != std::string::npos);
  CHECK(all.find(R"({"event":"started","mic":false,"sys":true})") != std::string::npos);
}

TEST(recorder_reinicia_o_sistema_uma_vez_e_depois_fica_fatal) {
  Capture cap;
  MemoryFrameSink sink;
  SimulatedPlatform::Script script;
  script.realTime = false;
  script.micBlocks = 50;
  script.systemStopsAfterBlocks = 20;
  SimulatedPlatform platform(script);
  RecorderOptions opt;
  opt.echoCancellation = false;
  opt.systemRetryDelay = std::chrono::milliseconds(50);
  {
    Recorder rec(platform, sink, cap.emitter, opt);
    rec.start();
    std::this_thread::sleep_for(std::chrono::milliseconds(400));
    rec.stop();
  }
  std::string all;
  for (auto& l : cap.lines) all += l + "\n";
  CHECK(all.find("captura do sistema parou, reiniciando") != std::string::npos);
  CHECK_EQ(platform.systemOpens(), 2);
  CHECK(all.find("\"fatal\":true") == std::string::npos);
}

TEST(exclude_pid_sobe_ate_a_raiz_do_mesmo_executavel) {
  std::vector<ProcessEntry> procs = {
      {4, 0, "System"}, {100, 4, "explorer.exe"}, {200, 100, "Spotify.exe"}, {201, 200, "spotify.exe"}, {202, 201, "Spotify.exe"}, {300, 100, "Rice.exe"}};
  CHECK_EQ(excludeTreeRoot({202, 300}, procs), 200L);  // vale o primeiro; filho do Spotify vira a raiz
  CHECK_EQ(excludeTreeRoot({300}, procs), 300L);
  CHECK_EQ(excludeTreeRoot({999}, procs), 999L);  // fora da lista: usa como veio
  CHECK_EQ(excludeTreeRoot({}, procs), 0L);
  std::vector<ProcessEntry> loop = {{10, 11, "a.exe"}, {11, 10, "a.exe"}};
  CHECK(excludeTreeRoot({10}, loop) != 0);  // ciclo não trava
}

TEST(recorder_repassa_todos_os_exclude_pid_na_ordem) {
  MemoryFrameSink sink;
  Capture cap;
  SimulatedPlatform::Script script;
  script.realTime = false;
  script.micBlocks = 5;
  SimulatedPlatform platform(script);
  RecorderOptions opt;
  opt.echoCancellation = false;
  opt.excludePids = {9120, 4242};  // Spotify antes do Rice: o Windows usa o primeiro
  {
    Recorder rec(platform, sink, cap.emitter, opt);
    rec.start();
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    rec.stop();
  }
  CHECK(platform.excludedPids() == std::vector<long>({9120, 4242}));
}
