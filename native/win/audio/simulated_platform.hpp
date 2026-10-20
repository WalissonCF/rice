// Plataforma sem hardware: tons sintéticos (mic 440 Hz, sys 880 Hz, 48 kHz estéreo, blocos de 10 ms em tempo real).
// Usada por --simulate-capture, pelo smoke test do CI e pelos testes do Recorder.
#pragma once

#include <atomic>
#include <mutex>

#include "platform.hpp"

namespace rice {

class SimulatedPlatform : public Platform {
 public:
  struct Script {
    bool micPermissionDenied = false;
    bool systemFails = false;
    bool headphones = false;
    bool realTime = true;  // false: gera os blocos o mais rápido possível (testes)
    int micBlocks = -1;    // quantos blocos gerar antes de parar sozinho (-1: sem fim)
    int systemStopsAfterBlocks = -1;  // a captura do sistema "para sozinha" depois desses blocos (-1: nunca)
  };

  SimulatedPlatform() = default;
  explicit SimulatedPlatform(Script script) : script_(script) {}

  std::unique_ptr<CaptureHandle> startMic(BlockCallback onBlock, std::function<void()> onDeviceChanged, std::function<void(std::string)> onFatal, std::string& error, CaptureFailure& failure) override;
  std::unique_ptr<CaptureHandle> startSystem(BlockCallback onBlock, std::function<void(std::string)> onStopped, const std::vector<long>& excludePids, std::string& error) override;
  void setPreferredInput(const std::string& id) override;
  void setMicDeviceListener(std::function<void(const MicDeviceInfo&)> listener) override;
  std::vector<InputDevice> listInputs() override;
  OutputInfo currentOutput() override;
  std::function<void()> observeOutput(std::function<void()> handler) override;
  bool preventSleep(std::string& warning) override;
  void allowSleep() override;

  /// Simula troca da saída padrão (dispara os observadores) para fone/alto-falante.
  void setHeadphones(bool value);
  /// Entradas simuladas (por padrão uma só, "sim-default"). As mudanças reavaliam a escolha como o WASAPI faria.
  void setInputs(std::vector<InputDevice> inputs);
  void plugInput(const InputDevice& device);
  void unplugInput(const std::string& id);
  void setDefaultInput(const std::string& id);
  int sleepBlocks() const { return sleepBlocks_.load(); }
  int sleepReleases() const { return sleepReleases_.load(); }
  int systemOpens() const { return systemOpens_.load(); }
  /// O que o último startSystem recebeu de --exclude-pid (ler depois do stop).
  std::vector<long> excludedPids() const { return excludedPids_; }

 private:
  Script script_;
  std::mutex mutex_;
  std::vector<std::function<void()>> observers_;
  std::atomic<int> sleepBlocks_{0};
  std::atomic<int> sleepReleases_{0};
  std::atomic<int> systemOpens_{0};
  std::vector<long> excludedPids_;
  std::atomic<bool> headphones_{false};
  void reevaluateMic();
  std::vector<InputDevice> inputs_ = {{"sim-default", "Microfone simulado", true, "active"}};
  std::string preferred_;
  MicDeviceTracker tracker_;
  std::function<void(const MicDeviceInfo&)> micListener_;
  bool micOpen_ = false;
};

}  // namespace rice
