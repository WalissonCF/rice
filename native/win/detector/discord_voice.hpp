// Quem está falando numa chamada do Discord (só Windows): o app lê a árvore de acessibilidade (UI Automation) da janela
// do Discord e o nome da pessoa ganha a classe `usernameSpeaking__*` enquanto ela fala. A leitura da árvore fica em
// detector/win/discord_uia.cpp; aqui fica a parte portável (árvore -> snapshot -> eventos), testada com fixture.
#pragma once

#include <map>
#include <optional>
#include <string>
#include <vector>

#include "../common/events.hpp"
#include "../common/json.hpp"

namespace rice {

/// Nó da árvore de UI Automation: só o que o reconhecimento usa (ClassName = classes CSS no Chromium, Name).
struct UiNode {
  std::string cls;
  std::string name;
  std::vector<UiNode> children;
};

/// Membros do canal de voz (lista lateral do servidor) e se cada um está falando. `self` = conta logada (o "Eu" do Rice).
struct VoiceSnapshot {
  std::string self;
  std::map<std::string, bool> members;
};

VoiceSnapshot discordVoiceSnapshot(const UiNode& root);

/// {"cls","name","children":[...]} -> UiNode (fixtures e --simulate-speakers).
UiNode uiNodeFromJson(const json::Value& value);

/// Transições de "falando": `speaker-active {app:"Discord", name, speaking}`. A conta logada nunca entra (a voz dela é o mic).
class SpeakerWatcher {
 public:
  explicit SpeakerWatcher(LineEmitter& out) : out_(out) {}
  void tick(const VoiceSnapshot& snapshot);

 private:
  LineEmitter& out_;
  std::map<std::string, bool> speaking_;  // nome -> true (só quem está falando)
};

/// Árvore atual da janela do Discord; nullopt sem janela ou fora do Windows. Chamar sempre da mesma thread.
std::optional<UiNode> readDiscordTree();

}  // namespace rice
