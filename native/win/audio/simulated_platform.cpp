#include "simulated_platform.hpp"

#include <chrono>
#include <cmath>
#include <thread>

namespace rice {

namespace {
constexpr double kPi = 3.14159265358979323846;
constexpr int kRate = 48000;
constexpr size_t kBlock = 480;  // 10 ms

class ToneThread : public CaptureHandle {
 public:
  ToneThread(double frequency, BlockCallback onBlock, bool realTime, int maxBlocks, std::function<void()> onEnd)
      : thread_([=, onBlock = std::move(onBlock), onEnd = std::move(onEnd)] {
          std::vector<float> stereo(kBlock * 2);
          auto next = std::chrono::steady_clock::now();
          for (int block = 0; !stop_ && (maxBlocks < 0 || block < maxBlocks); block++) {
            for (size_t i = 0; i < kBlock; i++) {
              double t = static_cast<double>(static_cast<size_t>(block) * kBlock + i) / kRate;
              float v = static_cast<float>(0.5 * std::sin(2 * kPi * frequency * t));
              stereo[2 * i] = v;
              stereo[2 * i + 1] = v;
            }
            onBlock(stereo.data(), kBlock, 2, kRate);
            if (realTime) {
              next += std::chrono::milliseconds(10);
              std::this_thread::sleep_until(next);
            }
          }
          if (!stop_ && onEnd) onEnd();
        }) {}
  ~ToneThread() override { stop(); }
  void stop() override {
    stop_ = true;
    if (thread_.joinable() && std::this_thread::get_id() != thread_.get_id()) thread_.join();
  }

 private:
  std::atomic<bool> stop_{false};
  std::thread thread_;
};
}  // namespace

void SimulatedPlatform::setPreferredInput(const std::string& id) {
  std::lock_guard<std::mutex> lock(mutex_);
  preferred_ = id;
}

void SimulatedPlatform::setMicDeviceListener(std::function<void(const MicDeviceInfo&)> listener) {
  std::lock_guard<std::mutex> lock(mutex_);
  micListener_ = std::move(listener);
}

std::vector<InputDevice> SimulatedPlatform::listInputs() {
  std::lock_guard<std::mutex> lock(mutex_);
  return inputs_;
}

void SimulatedPlatform::reevaluateMic() {
  MicDeviceInfo info;
  std::function<void(const MicDeviceInfo&)> listener;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!micOpen_ || !tracker_.update(preferred_, inputs_, info)) return;
    listener = micListener_;
  }
  if (listener) listener(info);
}

void SimulatedPlatform::setInputs(std::vector<InputDevice> inputs) {
  { std::lock_guard<std::mutex> lock(mutex_); inputs_ = std::move(inputs); }
  reevaluateMic();
}

void SimulatedPlatform::plugInput(const InputDevice& device) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    inputs_.push_back(device);
  }
  reevaluateMic();
}

void SimulatedPlatform::unplugInput(const std::string& id) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    bool wasDefault = false;
    for (auto it = inputs_.begin(); it != inputs_.end();) {
      if (it->id == id) { wasDefault = it->isDefault; it = inputs_.erase(it); } else ++it;
    }
    if (wasDefault && !inputs_.empty()) inputs_.front().isDefault = true;  // o Windows escolhe outro padrão
  }
  reevaluateMic();
}

void SimulatedPlatform::setDefaultInput(const std::string& id) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& d : inputs_) d.isDefault = d.id == id;
  }
  reevaluateMic();
}

std::unique_ptr<CaptureHandle> SimulatedPlatform::startMic(BlockCallback onBlock, std::function<void()>, std::function<void(std::string)>, std::string& error, CaptureFailure& failure) {
  if (script_.micPermissionDenied) {
    failure = CaptureFailure::PermissionDenied;
    error = "permissão de microfone negada";
    return nullptr;
  }
  MicDeviceInfo info;
  std::function<void(const MicDeviceInfo&)> listener;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    micOpen_ = true;
    tracker_.reset();
    if (tracker_.update(preferred_, inputs_, info)) listener = micListener_;
  }
  if (listener) listener(info);
  return std::make_unique<ToneThread>(440.0, std::move(onBlock), script_.realTime, script_.micBlocks, nullptr);
}

std::unique_ptr<CaptureHandle> SimulatedPlatform::startSystem(BlockCallback onBlock, std::function<void(std::string)> onStopped, const std::vector<long>& excludePids, std::string& error) {
  excludedPids_ = excludePids;
  if (script_.systemFails) {
    error = "dispositivo de saída indisponível";
    return nullptr;
  }
  int opens = ++systemOpens_;
  int limit = opens == 1 ? script_.systemStopsAfterBlocks : -1;
  return std::make_unique<ToneThread>(880.0, std::move(onBlock), script_.realTime, limit, [onStopped] { onStopped("simulado"); });
}

OutputInfo SimulatedPlatform::currentOutput() {
  OutputInfo info;
  info.name = "Simulada";
  info.isHeadphones = headphones_.load() || script_.headphones;
  info.reason = info.isHeadphones ? "fone (Simulada)" : "alto-falante (Simulada)";
  return info;
}

std::function<void()> SimulatedPlatform::observeOutput(std::function<void()> handler) {
  std::lock_guard<std::mutex> lock(mutex_);
  observers_.push_back(handler);
  return [] {};
}

void SimulatedPlatform::setHeadphones(bool value) {
  headphones_ = value;
  std::vector<std::function<void()>> copy;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    copy = observers_;
  }
  for (auto& f : copy) f();
}

bool SimulatedPlatform::preventSleep(std::string&) {
  sleepBlocks_++;
  return true;
}

void SimulatedPlatform::allowSleep() { sleepReleases_++; }

}  // namespace rice
