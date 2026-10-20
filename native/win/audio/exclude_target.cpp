#include "exclude_target.hpp"

#include <algorithm>
#include <cctype>

namespace rice {

namespace {

bool sameExe(const std::string& a, const std::string& b) {
  return a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin(), [](char x, char y) { return std::tolower(static_cast<unsigned char>(x)) == std::tolower(static_cast<unsigned char>(y)); });
}

const ProcessEntry* find(const std::vector<ProcessEntry>& processes, long pid) {
  for (const ProcessEntry& p : processes) {
    if (p.pid == pid) return &p;
  }
  return nullptr;
}

}  // namespace

long excludeTreeRoot(const std::vector<long>& pids, const std::vector<ProcessEntry>& processes) {
  if (pids.empty() || pids.front() <= 0) return 0;
  long pid = pids.front();
  const ProcessEntry* self = find(processes, pid);
  // limite de passos: pid reaproveitado pode formar ciclo pai→filho
  for (size_t steps = 0; self && steps < processes.size(); steps++) {
    const ProcessEntry* parent = self->parent != self->pid ? find(processes, self->parent) : nullptr;
    if (!parent || !sameExe(parent->exe, self->exe)) break;
    pid = parent->pid;
    self = parent;
  }
  return pid;
}

}  // namespace rice
