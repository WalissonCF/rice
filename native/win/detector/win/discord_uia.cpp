// Lê a árvore de UI Automation da janela do Discord (Electron/Chromium). O Chromium só monta a árvore de acessibilidade
// quando um cliente UIA pergunta: a primeira leitura pode vir incompleta, as seguintes vêm cheias.
#ifdef _WIN32
#include <windows.h>
#include <ole2.h>  // WIN32_LEAN_AND_MEAN (CMake) tira o OLE do windows.h; o uiautomation.h precisa dele
#include <uiautomation.h>

#include "../discord_voice.hpp"
#include "../window_list.hpp"

namespace rice {

namespace {

std::string utf8(BSTR text) {
  if (!text) return "";
  int len = static_cast<int>(SysStringLen(text));
  int size = WideCharToMultiByte(CP_UTF8, 0, text, len, nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text, len, out.data(), size, nullptr, nullptr);
  return out;
}

UiNode convert(IUIAutomationElement* element) {
  UiNode node;
  BSTR text = nullptr;
  if (SUCCEEDED(element->get_CachedClassName(&text))) node.cls = utf8(text);
  SysFreeString(text);
  text = nullptr;
  if (SUCCEEDED(element->get_CachedName(&text))) node.name = utf8(text);
  SysFreeString(text);
  IUIAutomationElementArray* children = nullptr;
  if (SUCCEEDED(element->GetCachedChildren(&children)) && children) {
    int count = 0;
    children->get_Length(&count);
    for (int i = 0; i < count; i++) {
      IUIAutomationElement* child = nullptr;
      if (SUCCEEDED(children->GetElement(i, &child)) && child) {
        node.children.push_back(convert(child));
        child->Release();
      }
    }
    children->Release();
  }
  return node;
}

/// Um IUIAutomation por thread (COM MTA), criado na primeira leitura e mantido até o processo sair.
IUIAutomation* automation() {
  thread_local IUIAutomation* uia = [] {
    IUIAutomation* created = nullptr;
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_IUIAutomation, reinterpret_cast<void**>(&created));
    return created;
  }();
  return uia;
}

}  // namespace

std::optional<UiNode> readDiscordTree() {
  IUIAutomation* uia = automation();
  if (!uia) return std::nullopt;
  WindowFilter filter;
  filter.exes = {"discord.exe"};
  HWND hwnd = nullptr;
  for (const auto& w : filterWindows(enumerateWindows(), filter)) {
    if (!w.title.empty()) {
      hwnd = reinterpret_cast<HWND>(static_cast<intptr_t>(w.hwnd));
      break;
    }
  }
  if (!hwnd) return std::nullopt;
  IUIAutomationElement* root = nullptr;
  if (FAILED(uia->ElementFromHandle(hwnd, &root)) || !root) return std::nullopt;
  std::optional<UiNode> tree;
  IUIAutomationCacheRequest* request = nullptr;
  IUIAutomationCondition* raw = nullptr;
  if (SUCCEEDED(uia->CreateCacheRequest(&request)) && SUCCEEDED(uia->get_RawViewCondition(&raw))) {
    request->AddProperty(UIA_ClassNamePropertyId);
    request->AddProperty(UIA_NamePropertyId);
    request->put_TreeScope(TreeScope_Subtree);
    request->put_TreeFilter(raw);
    request->put_AutomationElementMode(AutomationElementMode_None);  // só as propriedades: nada de referências vivas
    IUIAutomationElement* cached = nullptr;
    // ponytail: lê a janela inteira a cada passo (~1 mil nós); se pesar no Discord, guardar o nó `channels` e ler só ele.
    if (SUCCEEDED(root->BuildUpdatedCache(request, &cached)) && cached) {
      tree = convert(cached);
      cached->Release();
    }
  }
  if (raw) raw->Release();
  if (request) request->Release();
  root->Release();
  return tree;
}

}  // namespace rice
#endif  // _WIN32
