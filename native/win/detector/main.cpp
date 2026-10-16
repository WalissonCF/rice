// rice-detector (Windows e portátil): mesmos eventos e comandos do helper Swift (native/PROTOCOL.md).
// Calendário e Lembretes respondem "unsupported" / vazio: a agenda no Windows vem só do Google.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "../common/events.hpp"
#include "../common/json.hpp"
#include "app_matcher.hpp"
#include "discord_voice.hpp"
#include "mic_monitor.hpp"
#include "mic_watcher.hpp"
#include "window_list.hpp"

using namespace rice;

namespace {

std::string valueAfter(const std::vector<std::string>& args, const std::string& flag, bool& found) {
  for (size_t i = 0; i + 1 < args.size(); i++) {
    if (args[i] == flag) {
      found = true;
      return args[i + 1];
    }
  }
  found = false;
  return "";
}

bool hasFlag(const std::vector<std::string>& args, const std::string& flag) {
  for (const auto& a : args) {
    if (a == flag) return true;
  }
  return false;
}

void printLine(const std::string& text) {
  std::fwrite(text.data(), 1, text.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

/// Passos de --simulate-mic / --fake-mic-steps: [["id",...],[...]].
std::vector<std::vector<std::string>> parseSteps(const std::string& text) {
  std::vector<std::vector<std::string>> steps;
  auto parsed = json::parse(text);
  if (!parsed || !parsed->isArray()) return steps;
  for (const auto& step : parsed->items()) {
    std::vector<std::string> ids;
    if (step.isArray()) {
      for (const auto& id : step.items()) {
        if (id.isString()) ids.push_back(id.str());
      }
    }
    steps.push_back(std::move(ids));
  }
  return steps;
}

json::Value stringArray(const std::vector<std::string>& values) {
  json::Value out = json::Value::array();
  for (const auto& v : values) out.push(v);
  return out;
}

/// Todos os valores de `flag` (repetível): --app Zoom --app "Google Chrome".
std::vector<std::string> allValuesAfter(const std::vector<std::string>& args, const std::string& flag) {
  std::vector<std::string> out;
  for (size_t i = 0; i + 1 < args.size(); i++) {
    if (args[i] == flag) out.push_back(args[i + 1]);
  }
  return out;
}

/// Janelas simuladas (--fake-windows '<json>' ou RICE_DETECTOR_FAKE_WINDOWS): no lugar do EnumWindows, para os testes.
std::optional<std::vector<WindowInfo>> fakeWindows(const std::vector<std::string>& args) {
  bool found = false;
  std::string text = valueAfter(args, "--fake-windows", found);
  if (!found) {
    const char* env = std::getenv("RICE_DETECTOR_FAKE_WINDOWS");
    if (!env || !*env) return std::nullopt;
    text = env;
  }
  auto parsed = json::parse(text);
  return parsed ? windowsFromJson(*parsed) : std::vector<WindowInfo>{};
}

std::vector<WindowInfo> currentWindows(const std::vector<std::string>& args) {
  if (auto fake = fakeWindows(args)) return *fake;
  return enumerateWindows();
}

json::Value listWindowsJson(const std::vector<WindowInfo>& windows, const WindowFilter& filter) {
  return windowsToJson(filterWindows(windows, filter));
}

json::Value snapshotJson(const VoiceSnapshot& snapshot) {
  json::Value members = json::Value::object();
  for (const auto& [name, speaking] : snapshot.members) members.set(name, speaking);
  json::Value f = json::Value::object();
  f.set("self", snapshot.self).set("members", std::move(members));
  return f;
}

/// `watch-speakers` / `stop-speakers`: lê o Discord a cada `interval` só enquanto o Rice pede (gravando uma chamada do Discord).
class SpeakerPoller {
 public:
  SpeakerPoller(LineEmitter& out, std::chrono::milliseconds interval) : out_(out), interval_(interval) {}
  ~SpeakerPoller() { stop(); }

  void start() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (thread_.joinable()) return;
    running_ = true;
    thread_ = std::thread([this] { run(); });
  }

  void stop() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!thread_.joinable()) return;
      running_ = false;
    }
    wake_.notify_all();
    thread_.join();
  }

 private:
  void run() {
    SpeakerWatcher watcher(out_);
    std::unique_lock<std::mutex> lock(mutex_);
    while (running_) {
      lock.unlock();
      auto tree = readDiscordTree();
      watcher.tick(tree ? discordVoiceSnapshot(*tree) : VoiceSnapshot{});
      lock.lock();
      wake_.wait_for(lock, interval_, [this] { return !running_; });
    }
    lock.unlock();
    watcher.tick(VoiceSnapshot{});  // parou: fecha quem ainda estava falando
  }

  LineEmitter& out_;
  std::chrono::milliseconds interval_;
  std::mutex mutex_;
  std::condition_variable wake_;
  bool running_ = false;
  std::thread thread_;
};

json::Value accessFields() {
  json::Value f = json::Value::object();
  f.set("status", "unsupported");
  return f;
}

}  // namespace

int main(int argc, char** argv) {
  std::vector<std::string> args;
  for (int i = 1; i < argc; i++) args.emplace_back(argv[i]);
  LineEmitter out = makeStdoutEmitter();
  bool found = false;

  std::string idToMatch = valueAfter(args, "--match", found);
  if (found || hasFlag(args, "--match")) {
    json::Value f = json::Value::object();
    auto app = matchApp(idToMatch);
    f.set("app", app ? json::Value(*app) : json::Value(nullptr));
    printLine(f.dump());
    return 0;
  }
  if (hasFlag(args, "--print-mic-processes")) {
    printLine(stringArray(identifiersUsingMic()).dump());
    return 0;
  }
  if (hasFlag(args, "--list-windows")) {
    // Resposta única: array de janelas visíveis (da frente para trás) dos apps/processos pedidos; sem filtro, todas.
    WindowFilter filter;
    filter.apps = allValuesAfter(args, "--app");
    filter.exes = allValuesAfter(args, "--exe");
    for (const auto& pid : allValuesAfter(args, "--pid")) filter.pids.push_back(std::strtoul(pid.c_str(), nullptr, 10));
    enableDpiAwareness();
    printLine(listWindowsJson(currentWindows(args), filter).dump());
    return 0;
  }
  std::string treesText = valueAfter(args, "--simulate-speakers", found);
  if (found) {
    // Passos = árvores de UI Automation do Discord ({cls,name,children}); imprime os speaker-active gerados.
    SpeakerWatcher watcher(out);
    auto parsed = json::parse(treesText);
    if (parsed && parsed->isArray()) {
      for (const auto& tree : parsed->items()) watcher.tick(discordVoiceSnapshot(uiNodeFromJson(tree)));
    }
    return 0;
  }
  if (hasFlag(args, "--print-discord-voice")) {
    auto tree = readDiscordTree();
    printLine(tree ? snapshotJson(discordVoiceSnapshot(*tree)).dump() : "null");
    return 0;
  }
  std::string stepsText = valueAfter(args, "--simulate-mic", found);
  if (found) {
    MicWatcher watcher(out);
    for (const auto& step : parseSteps(stepsText)) watcher.tick(step);
    return 0;
  }
  if (hasFlag(args, "--once")) {
    json::Value f = json::Value::object();
    f.set("event", "snapshot").set("micInUse", stringArray(identifiersUsingMic())).set("calendarAccess", "unsupported").set("upcoming", json::Value::array());
    printLine(f.dump());
    return 0;
  }

  enableDpiAwareness();
  // Modo watch (usado pelo Rice).
  out.emit("calendar-access", accessFields());
  out.emit("reminders-access", accessFields());

  std::vector<std::vector<std::string>> fakeSteps;
  std::string fakeText = valueAfter(args, "--fake-mic-steps", found);
  bool fake = found;
  // RICE_DETECTOR_FAKE_MIC_STEPS: o mesmo, por variável de ambiente (o main do Electron lança o helper sem argumentos).
  if (!fake) {
    const char* env = std::getenv("RICE_DETECTOR_FAKE_MIC_STEPS");
    if (env && *env) {
      fake = true;
      fakeText = env;
    }
  }
  if (fake) fakeSteps = parseSteps(fakeText);
  bool hasInterval = false;
  std::string intervalText = valueAfter(args, "--fake-mic-interval-ms", hasInterval);
  const char* intervalEnv = std::getenv("RICE_DETECTOR_FAKE_MIC_INTERVAL_MS");
  if (!hasInterval && intervalEnv && *intervalEnv) {
    hasInterval = true;
    intervalText = intervalEnv;
  }
  const auto interval = std::chrono::milliseconds(hasInterval ? std::strtol(intervalText.c_str(), nullptr, 10) : 2000);

  std::atomic<bool> quit{false};
  std::mutex quitMutex;
  std::condition_variable quitWake;
  std::thread poller([&] {
    MicWatcher watcher(out);
    size_t step = 0;
    while (!quit) {
      if (fake) {
        if (!fakeSteps.empty()) watcher.tick(fakeSteps[std::min(step, fakeSteps.size() - 1)]);
        step++;
      } else {
        watcher.tick(identifiersUsingMic());
      }
      std::unique_lock<std::mutex> lock(quitMutex);
      quitWake.wait_for(lock, interval, [&] { return quit.load(); });
    }
  });

  SpeakerPoller speakers(out, std::chrono::milliseconds(250));
  std::string line;
  while (std::getline(std::cin, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    auto command = json::parseCommand(line);
    if (!command) {
      json::Value f = json::Value::object();
      f.set("message", "invalid command line");
      out.emit("error", std::move(f));
      continue;
    }
    const std::string& name = command->name;
    json::Value f = json::Value::object();
    if (name == "current-event") {
      f.set("id", nullptr);
      out.emit("current-event", std::move(f));
    } else if (name == "list-events") {
      f.set("events", json::Value::array());
      out.emit("events-list", std::move(f));
    } else if (name == "list-windows") {
      // Pedido do Rice (só Windows): {"cmd":"list-windows","apps":["Zoom"],"exes":["chrome.exe"],"pids":[123]}.
      WindowFilter filter;
      auto strings = [&](const char* key) {
        std::vector<std::string> v;
        if (const json::Value* a = command->body.get(key); a && a->isArray()) {
          for (const auto& item : a->items()) {
            if (item.isString()) v.push_back(item.str());
          }
        }
        return v;
      };
      filter.apps = strings("apps");
      filter.exes = strings("exes");
      if (const json::Value* a = command->body.get("pids"); a && a->isArray()) {
        for (const auto& item : a->items()) {
          if (item.isNumber()) filter.pids.push_back(static_cast<unsigned long>(item.integer()));
        }
      }
      f.set("windows", listWindowsJson(currentWindows(args), filter));
      out.emit("windows-list", std::move(f));
    } else if (name == "watch-speakers") {
      // Pedido do Rice (só Windows): {"cmd":"watch-speakers","app":"Discord"}. Sem resposta; eventos speaker-active até stop-speakers.
      if (command->body.getString("app") == "Discord") speakers.start();
    } else if (name == "stop-speakers") {
      speakers.stop();
    } else if (name == "request-calendar-access") {
      out.emit("calendar-access", accessFields());
    } else if (name == "list-reminders") {
      f.set("reminders", json::Value::array());
      out.emit("reminders-list", std::move(f));
    } else if (name == "request-reminders-access") {
      out.emit("reminders-access", accessFields());
    } else if (name == "complete-reminder") {
      f.set("id", command->body.getString("id")).set("ok", false);
      out.emit("reminder-completed", std::move(f));
    } else {
      f.set("message", "unknown command: " + name);
      out.emit("error", std::move(f));
    }
  }
  // EOF: o pai fechou o stdin. Todos os comandos são síncronos, então já foram respondidos.
  speakers.stop();
  {
    std::lock_guard<std::mutex> lock(quitMutex);
    quit = true;
  }
  quitWake.notify_all();
  poller.join();
  return 0;
}
