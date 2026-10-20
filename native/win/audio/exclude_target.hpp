// Qual árvore de processos o loopback por processo do Windows exclui. Portável: o lado Win32 só lista os processos.
#pragma once

#include <string>
#include <vector>

namespace rice {

struct ProcessEntry {
  long pid = 0;
  long parent = 0;
  std::string exe;  // nome do executável, ex. "Spotify.exe"
};

/// O modo EXCLUDE do Windows aceita UMA árvore por fluxo: vale o primeiro `--exclude-pid`, subindo pelos pais enquanto
/// o executável é o mesmo (qualquer Spotify.exe filho vira o Spotify.exe raiz, e a árvore inteira some). 0 = nada a excluir.
long excludeTreeRoot(const std::vector<long>& pids, const std::vector<ProcessEntry>& processes);

}  // namespace rice
