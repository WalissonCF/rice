#include "discord_voice.hpp"

#include <sstream>

namespace rice {

namespace {

/// As classes do Discord têm sufixo de hash que muda a cada versão (`voiceUser__07f91`): compara só o prefixo de cada classe.
bool hasClass(const UiNode& node, const std::string& prefix) {
  std::istringstream classes(node.cls);
  std::string c;
  while (classes >> c) {
    if (c.compare(0, prefix.size(), prefix) == 0) return true;
  }
  return false;
}

const UiNode* findClass(const UiNode& node, const std::string& prefix) {
  if (hasClass(node, prefix)) return &node;
  for (const auto& child : node.children) {
    if (const UiNode* found = findClass(child, prefix)) return found;
  }
  return nullptr;
}

/// Primeiro nome não vazio da subárvore (o Text com o nome da pessoa).
std::string firstName(const UiNode& node) {
  if (!node.name.empty()) return node.name;
  for (const auto& child : node.children) {
    std::string name = firstName(child);
    if (!name.empty()) return name;
  }
  return "";
}

void collect(const UiNode& node, VoiceSnapshot& snapshot) {
  if (hasClass(node, "voiceUser__")) {
    if (const UiNode* username = findClass(node, "usernameFont__")) {
      std::string name = firstName(*username);
      if (!name.empty()) snapshot.members[name] = snapshot.members[name] || hasClass(*username, "usernameSpeaking__");
    }
    return;
  }
  if (snapshot.self.empty() && hasClass(node, "accountPopoutButtonWrapper__")) {
    if (const UiNode* title = findClass(node, "title_")) snapshot.self = firstName(*title);
    return;
  }
  for (const auto& child : node.children) collect(child, snapshot);
}

}  // namespace

VoiceSnapshot discordVoiceSnapshot(const UiNode& root) {
  VoiceSnapshot snapshot;
  collect(root, snapshot);
  return snapshot;
}

UiNode uiNodeFromJson(const json::Value& value) {
  UiNode node;
  node.cls = value.getString("cls");
  node.name = value.getString("name");
  if (const json::Value* children = value.get("children"); children && children->isArray()) {
    for (const auto& child : children->items()) node.children.push_back(uiNodeFromJson(child));
  }
  return node;
}

void SpeakerWatcher::tick(const VoiceSnapshot& snapshot) {
  std::map<std::string, bool> now;
  for (const auto& [name, speaking] : snapshot.members) {
    if (speaking && name != snapshot.self) now[name] = true;
  }
  auto emit = [&](const std::string& name, bool speaking) {
    json::Value f = json::Value::object();
    f.set("app", "Discord").set("name", name).set("speaking", speaking);
    out_.emit("speaker-active", std::move(f));
  };
  for (const auto& [name, _] : speaking_) {
    if (!now.count(name)) emit(name, false);
  }
  for (const auto& [name, _] : now) {
    if (!speaking_.count(name)) emit(name, true);
  }
  speaking_ = std::move(now);
}

#ifndef _WIN32
std::optional<UiNode> readDiscordTree() { return std::nullopt; }
#endif

}  // namespace rice
