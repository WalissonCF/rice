const $ = (id) => document.getElementById(id);
const t = (key, vars) => window.RiceI18n.t(key, vars);
function build(tag, props, children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
}

// idioma do app: vem do main de forma síncrona (preload) e vale desde a primeira renderização
window.RiceI18n.setLanguage(window.rice.uiLanguage);
window.RiceI18n.applyDom();
window.RiceIcons.apply();

let current = null;
/** A reunião aberta foi criada em "Nova reunião" e ainda não foi gravada. */
let openIsDraft = false;
/** A reunião aberta já foi gravada: o botão principal continua a gravação nela. */
let openIsRecorded = false;
let chatId = 0;
let saveTimer = null;
let recState = 'idle';
let recDir = null;
let openStartedAt = null;
let transcriptNode = null;
let openAnnotations = null; // as anotações da reunião aberta (RiceAnnotations: value e markSaved)
let redrawMeeting = null; // redesenha as abas da reunião aberta (Ideias/Investigação mudaram)
const warRoom = window.RiceWarRoom.create({
  rice: window.rice,
  indicator: $('wr-indicator'),
  onUpdate: () => redrawMeeting && redrawMeeting(true),
  onLearnMore: () => showGuide('warroom'),
  onManageIdeaTemplates: () => showTemplates('ideas'),
  onChangeAi: (provider) => openAiSettings(provider),
  notice: (message) => setWarning(message),
  confirm: (lines, label) => confirmDialog(lines, label),
  warn: (message) => setWarning(t('common.error', { message })),
  getAnnotations: () => (openAnnotations || { value: '' }).value, // o campo vive na aba Notas, que pode não estar na tela
  setAnnotations: (text) => {
    if (openAnnotations) openAnnotations.value = text;
  },
});
const attachDeps = { rice: window.rice, warn: (message) => setWarning(t('common.error', { message })) };
const attachments = window.RiceAttachments.create(attachDeps);
const screens = window.RiceScreenshots.create({ rice: window.rice, warn: (message) => setWarning(message) });
const shotsChip = window.RiceScreenshots.chip({ rice: window.rice, node: $('shots-chip'), captureNode: $('shots-capture') });
const syncShotsChip = () => shotsChip.sync({ recording: recState === 'recording', dir: recDir });
// microfone em uso (Mac: entrada padrão pelo detector; Windows: evento do helper): chip perto do Parar e aviso quando troca no meio
const micChip = window.RiceMicChip.create({ node: $('mic-chip'), notice: (text) => window.RiceToastStack.notice(text), api: window.rice.platform === 'darwin' && window.rice.micInputs ? { micInputs: () => window.rice.micInputs(), micSwitch: (id) => window.rice.micSwitch(id), micMuteIgnore: () => window.rice.micMuteIgnore() } : null });
window.rice.on('session:mic', (info) => micChip.show(info));
window.rice.on('session:mic-mute', (info) => micChip.mute(info)); // Mac: "Seu microfone parece mudo. Trocar para X?"
if (window.rice.micCurrent) window.rice.micCurrent().then((info) => info && micChip.show(info)).catch(() => {});
window.rice.on('screenshots:changed', (p) => {
  screens.changed(p);
  shotsChip.changed(p);
});
const liveScroll = window.RiceLiveScroll.create({ detail: $('detail'), button: $('live-jump') });
let opening = false;
let queuedSegments = [];
let renderedLines = new Set();
/** Uma linha parcial (cinza, itálico) por falante, sempre no fim da transcrição. */
let partialRows = new Map();
let streamNode = null;
let streamRaw = '';
const md = (text) => window.RiceMarkdown.renderMarkdown(text, document);
const memoryPage = window.RiceMemoryPage.create({ rice: window.rice, onOpenMeeting: (dir) => openMeeting(dir), confirm: (message, label) => confirmDialog(message, label), button: (text, onclick, kind) => { const b = build('button', { type: 'button', className: `btn ${kind || 'ghost'}`, textContent: text }, []); b.onclick = onclick; return b; } });
const followupsPage = window.RiceFollowups.create({ rice: window.rice, onOpen: (dir) => openMeeting(dir), warn: (message) => setWarning(message) });
/** Notas: a citação de uma captura vira a miniatura, só para capturas da reunião aberta. */
const mdNotes = (text) => window.RiceMarkdown.renderMarkdown(text, document, { shot: (id) => screens.noteShot(id), onTask: (label, checked) => current && window.rice.followupsToggleNoteTask && window.rice.followupsToggleNoteTask(current, label, checked) }); // marcar uma tarefa nas notas reflete nas Pendências
const notesPending = new Set();
/** Progresso das notas em geração por reunião: { phase: 'extract' | 'write', part, total } (reuniões longas mostram a parte). */
const notesProgress = new Map();
const clearTimers = {};
const status = { download: '', asr: '', asrFailed: false, capture: '', warning: '' };
/** Último estado da transcrição, para repintar o texto se o idioma mudar. */
let lastAsrStatus = null;

function updateAsrStatus() {
  const s = lastAsrStatus;
  status.asrFailed = Boolean(s && s.state === 'failed');
  status.asr = !s ? '' : s.state === 'failed' ? (s.error ? t('status.asr-failed-detail', { error: s.error }) : t('status.asr-failed')) : s.queueSeconds > 60 ? t('status.asr-delayed', { s: Math.round(s.queueSeconds) }) : '';
}

async function refreshRoot() {
  const { root } = await window.rice.getSettings();
  $('root').textContent = root;
  $('root').title = root;
}

let lastMeetings = [];
let editingList = false;
let searchQuery = '';
let searchTimer = null;
let searchSeq = 0;
let resultsCtl = null;
let searchWords = [];
const SEARCH_DEBOUNCE_MS = 120;

/** Pastas de agrupamento (rótulos; a pasta física da reunião não se move). */
let foldersCache = [];
const FOLDER_PREF_KEY = 'rice.folderCollapsed';

function readCollapsed() {
  try {
    const raw = JSON.parse(localStorage.getItem(FOLDER_PREF_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function setCollapsed(id, collapsed) {
  const all = readCollapsed();
  if (collapsed) all[id] = true;
  else delete all[id];
  try {
    localStorage.setItem(FOLDER_PREF_KEY, JSON.stringify(all));
  } catch {
    // sem armazenamento: só não lembra
  }
}

const MAX_FOLDER_DEPTH = 4;
const folderById = (id) => foldersCache.find((f) => f.id === id);
const subfoldersOf = (parentId) => foldersCache.filter((f) => (f.parentId || null) === (parentId || null));
/** Pasta e tudo dentro dela (ids). */
function folderSubtreeIds(id) {
  const out = [id];
  for (const sub of subfoldersOf(id)) out.push(...folderSubtreeIds(sub.id));
  return out;
}
const folderDepth = (id) => {
  let depth = 0;
  for (let f = folderById(id); f && depth <= foldersCache.length; f = f.parentId ? folderById(f.parentId) : null) depth++;
  return depth;
};
const folderHeight = (id) => 1 + Math.max(0, ...subfoldersOf(id).map((f) => folderHeight(f.id)));
/** Pastas em ordem de árvore, cada uma com o nível (0 = raiz). */
function flattenFolders(parentId, level) {
  return subfoldersOf(parentId).flatMap((f) => [{ folder: f, level: level || 0 }, ...flattenFolders(f.id, (level || 0) + 1)]);
}
/** "Clientes / Acme" */
function folderPath(id) {
  const names = [];
  for (let f = folderById(id); f && names.length <= MAX_FOLDER_DEPTH; f = f.parentId ? folderById(f.parentId) : null) names.unshift(f.name);
  return names.join(' / ');
}
const folderName = (m) => (m.folderId ? folderPath(m.folderId) : '');
/** Com `rice.search` a busca olha o conteúdo (título, notas, transcrição, anotações) e a lista vira resultados; sem ele, filtra só título e pasta. */
const contentSearch = () => typeof window.rice.search === 'function';
const matchesSearch = (m) => !searchQuery || contentSearch() || m.title.toLowerCase().includes(searchQuery) || folderName(m).toLowerCase().includes(searchQuery);

const MEETING_DRAG = 'application/x-rice-meeting';
const FOLDER_DRAG = 'application/x-rice-folder';
const hasType = (e, type) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes(type);

async function setFolderOf(dir, folderId) {
  const result = await window.rice.setMeetingFolder(dir, folderId);
  if (!result.ok) setWarning(t('common.error', { message: result.message }));
  await refreshList();
}

/** Cria a pasta `name` e (opcional) já move a reunião `dir` para ela. */
async function createFolderNamed(name, dir, parentId) {
  const result = await (parentId ? window.rice.createFolder(name, parentId) : window.rice.createFolder(name));
  if (!result.ok) {
    setWarning(t('common.error', { message: result.message }));
    return null;
  }
  if (dir) await window.rice.setMeetingFolder(dir, result.value.id);
  await refreshList();
  return result.value;
}

/** Pede um nome num diálogo curto (Nova pasta… a partir do menu da reunião). */
function askFolderName(onName, title) {
  const D = window.RiceDialog;
  openDialog(title || t('folder.prompt.title'), (box, close) => {
    const input = build('input', { placeholder: t('folder.new-ph'), autocomplete: 'off', maxLength: 60 }, []);
    const go = () => {
      const name = input.value.trim();
      if (!name) return;
      close();
      onName(name);
    };
    box.body.append(D.field(t('folder.name-label'), input));
    box.foot.append(D.button(t('common.cancel'), 'ghost', close), D.button(t('folder.prompt.create'), 'primary', go));
  }, { enterConfirms: true });
}

function buildMeetingItem(m, inTree) {
  const time = new Date(m.startedAt).toLocaleTimeString(window.RiceI18n.locale(), { hour: '2-digit', minute: '2-digit' });
  const item = build('div', { className: 'meeting' + (current === m.dir ? ' active' : '') + (inTree ? ' in-tree' : ''), title: `${m.title} — ${time}`, draggable: true }, [
    ...(inTree ? [build('span', { className: 'tree-dot' }, [])] : []),
    build('span', { className: 'm-title', textContent: m.title }, []),
    ...(recState === 'recording' && recDir === m.dir ? [build('span', { className: 'live-dot' + (recPaused ? ' paused' : ''), title: t(recPaused ? 'rec.paused' : 'live.in-progress') }, [])] : []),
    ...(m.state === 'interrupted' ? [build('span', { className: 'm-dot', title: t('meeting.interrupted') }, [])] : []),
    ...(m.state === 'damaged' ? [build('span', { className: 'm-dot', title: t('meeting.damaged') }, [])] : []),
    build('small', { textContent: m.state === 'finishing' ? t('meeting.finishing') : time }, []),
  ]);
  item.dataset.dir = m.dir;
  const more = build('button', { className: 'm-more', type: 'button', title: t('menu.more') }, []);
  more.append(window.RiceIcons.icon('more'));
  more.setAttribute('aria-label', t('menu.more'));
  more.setAttribute('aria-haspopup', 'menu');
  const menu = (anchorOrPoint) => window.RiceActionMenu.open({ ...anchorOrPoint, items: meetingMenuItems(m.dir, m.title, () => renameInList(item, m), m.folderId) });
  more.onclick = (e) => {
    e.stopPropagation(); // abre só o menu, não a reunião
    menu({ anchor: more });
  };
  item.append(more);
  item.oncontextmenu = (e) => {
    e.preventDefault();
    menu({ at: { x: e.clientX, y: e.clientY } });
  };
  item.onclick = () => (m.state === 'damaged' ? openDamaged(m) : openMeeting(m.dir));
  item.ondblclick = () => renameInList(item, m);
  // arrastar para uma pasta: só o `dir` viaja (o main valida)
  item.ondragstart = (e) => {
    e.dataTransfer.setData(MEETING_DRAG, m.dir);
    e.dataTransfer.effectAllowed = 'move';
    document.body.classList.add('dragging-meeting');
  };
  item.ondragend = () => document.body.classList.remove('dragging-meeting');
  return item;
}

/** Itens "Mover para ▸" de uma pasta: a árvore, com a própria pasta e as de dentro desabilitadas (e as que estourariam os 4 níveis). */
function folderMoveItems(folder) {
  const inside = new Set(folderSubtreeIds(folder.id));
  const height = folderHeight(folder.id);
  const target = (parent, level, label) => {
    const blockedByDepth = parent !== null && folderDepth(parent) + height > MAX_FOLDER_DEPTH;
    const disabled = (parent !== null && inside.has(parent)) || blockedByDepth;
    return {
      icon: 'folder',
      label,
      indent: level,
      checked: (folder.parentId || null) === parent,
      disabled,
      ...(blockedByDepth ? { title: t('folder.err.depth', { max: MAX_FOLDER_DEPTH }) } : {}),
      onSelect: () => ((folder.parentId || null) === parent ? undefined : moveFolderTo(folder.id, parent)),
    };
  };
  return [target(null, 0, t('folder.root')), ...flattenFolders(null, 0).map(({ folder: f, level }) => target(f.id, level + 1, f.name))];
}

async function moveFolderTo(id, parentId) {
  const result = await window.rice.moveFolder(id, parentId);
  if (!result.ok) setWarning(t('common.error', { message: result.message }));
  await refreshList();
}

/** Texto de confirmação ao apagar: o que sobe para a pasta-mãe. */
function deleteFolderMessage(folder) {
  const subs = folderSubtreeIds(folder.id).length - 1;
  const direct = lastMeetings.filter((m) => m.folderId === folder.id).length;
  if (!folder.parentId && subs === 0) return t('folder.delete-confirm', { name: folder.name });
  const items = [subs > 0 && window.RiceI18n.tn('folder.n-sub', subs), direct > 0 && window.RiceI18n.tn('folder.n-meet', direct)].filter(Boolean).join(' · ');
  if (!items) return t('folder.delete-empty', { name: folder.name });
  return folder.parentId
    ? t('folder.delete-up', { name: folder.name, items, parent: (folderById(folder.parentId) || { name: '' }).name })
    : t('folder.delete-up-root', { name: folder.name, items });
}

/** Menu ⋯ / clique direito de uma pasta. */
function folderMenuItems(folder, rename) {
  return [
    { icon: 'pencil', label: t('folder.menu.rename'), onSelect: rename },
    {
      icon: 'plus',
      label: t('folder.menu.new-meeting'),
      onSelect: async () => openMeeting(await window.rice.createMeeting('', undefined, folder.id)),
    },
    {
      icon: 'folder-plus',
      label: t('folder.menu.new-sub'),
      disabled: folderDepth(folder.id) >= MAX_FOLDER_DEPTH,
      ...(folderDepth(folder.id) >= MAX_FOLDER_DEPTH ? { title: t('folder.err.depth', { max: MAX_FOLDER_DEPTH }) } : {}),
      onSelect: () => askFolderName((name) => createFolderNamed(name, null, folder.id), t('folder.menu.new-sub')),
    },
    { icon: 'move', label: t('folder.menu.move'), submenu: folderMoveItems(folder) },
    { separator: true },
    // privacidade da pasta: ocultar dados pessoais ao enviar para a IA (as subpastas herdam) e o tempo de guarda (vai para a Lixeira)
    {
      icon: 'shield',
      label: t('folder.sensitive'),
      title: t('folder.sensitive.title'),
      checked: folder.sensitive === true,
      onSelect: async () => {
        const result = await window.rice.setFolderPrivacy(folder.id, { sensitive: folder.sensitive !== true });
        if (result && result.ok === false) setWarning(t('common.error', { message: result.message }));
        await refreshList();
      },
    },
    { icon: 'history', label: t('folder.retention'), onSelect: () => window.RiceRetention.open(folder, () => refreshList()) },
    { separator: true },
    {
      icon: 'trash',
      label: t('folder.menu.delete'),
      danger: true,
      onSelect: async () => {
        if (!(await confirmDialog(deleteFolderMessage(folder), t('folder.delete-action')))) return;
        const result = await window.rice.deleteFolder(folder.id);
        if (!result.ok) setWarning(t('common.error', { message: result.message }));
        await refreshList();
      },
    },
  ];
}

/** Pasta sendo arrastada (o `dataTransfer` só entrega o valor no drop). */
let draggingFolder = null;

/** Onde o arrasto cai na linha da pasta: borda de cima/de baixo reordena entre irmãs, o meio move para dentro. */
function dropZone(e, row) {
  const box = row.getBoundingClientRect();
  const y = e.clientY - box.top;
  return y < box.height * 0.28 ? 'before' : y > box.height * 0.72 ? 'after' : 'into';
}

const clearDropMarks = (row) => row.classList.remove('drop-target', 'drop-before', 'drop-after');

/** Solta uma pasta em `target`: dentro dela, ou antes/depois dela entre as irmãs (muda de pai se precisar). */
async function dropFolderOn(draggedId, target, zone) {
  if (draggedId === target.id) return;
  if (zone === 'into') return moveFolderTo(draggedId, target.id);
  const parent = target.parentId || null;
  const dragged = folderById(draggedId);
  if (!dragged) return;
  if ((dragged.parentId || null) !== parent) {
    const moved = await window.rice.moveFolder(draggedId, parent);
    if (!moved.ok) {
      setWarning(t('common.error', { message: moved.message }));
      return;
    }
  }
  const ids = subfoldersOf(parent).map((f) => f.id).filter((id) => id !== draggedId);
  ids.splice(ids.indexOf(target.id) + (zone === 'after' ? 1 : 0), 0, draggedId);
  const result = await window.rice.reorderFolders(ids);
  if (!result.ok) setWarning(t('common.error', { message: result.message }));
  await refreshList();
}

/** Uma pasta da árvore: a linha e, se aberta, as subpastas e as reuniões dela (com as linhas-guia em CSS). */
function buildFolderBlock(folder, ctx) {
  const subs = subfoldersOf(folder.id);
  const kids = ctx.meetings.filter((m) => m.folderId === folder.id);
  const total = ctx.meetings.filter((m) => folderSubtreeIds(folder.id).includes(m.folderId)).length;
  if (ctx.searching && total === 0) return null;
  const collapsed = ctx.searching ? false : Boolean(ctx.collapsed[folder.id]);
  const expandable = subs.length > 0 || kids.length > 0;
  const block = build('div', { className: 'folder-block' + (collapsed ? ' collapsed' : '') + (expandable ? '' : ' leaf') }, []);
  const row = build('div', { className: 'folder-row' + (expandable ? '' : ' leaf'), draggable: true }, []);
  row.dataset.folderId = folder.id;
  const toggle = build('button', { className: 'folder-toggle', type: 'button' }, [window.RiceIcons.icon(collapsed ? 'chevron-right' : 'chevron-down')]);
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', t('folder.toggle', { name: folder.name }));
  if (!expandable) toggle.tabIndex = -1;
  const name = build('span', { className: 'folder-name', textContent: folder.name }, []);
  const count = build('small', { className: 'folder-count', textContent: String(total), title: window.RiceI18n.tn('folder.count', total) }, []);
  const more = build('button', { className: 'm-more f-more', type: 'button', title: t('menu.more') }, [window.RiceIcons.icon('more')]);
  more.setAttribute('aria-label', t('menu.more'));
  more.setAttribute('aria-haspopup', 'menu');
  row.append(toggle, build('span', { className: 'folder-ico' }, [window.RiceIcons.icon('folder')]), name, count, more);
  const flip = () => {
    if (!expandable) return;
    setCollapsed(folder.id, !collapsed);
    refreshList();
  };
  row.onclick = flip;
  toggle.onclick = (e) => {
    e.stopPropagation();
    flip();
  };
  const rename = () => {
    editingList = true;
    const input = titleInput(folder.name, 'title-edit', async (next) => {
      editingList = false;
      if (next) {
        const result = await window.rice.renameFolder(folder.id, next);
        if (!result.ok) setWarning(t('common.error', { message: result.message }));
      }
      await refreshList();
    });
    row.replaceChildren(input);
    input.focus();
    input.select();
  };
  const menu = (where) => window.RiceActionMenu.open({ ...where, items: folderMenuItems(folder, rename) });
  more.onclick = (e) => {
    e.stopPropagation();
    menu({ anchor: more });
  };
  row.oncontextmenu = (e) => {
    e.preventDefault();
    menu({ at: { x: e.clientX, y: e.clientY } });
  };
  // reunião solta na pasta entra nela; pasta solta no meio entra como subpasta; na borda de cima/de baixo reordena entre irmãs
  row.ondragover = (e) => {
    const meeting = hasType(e, MEETING_DRAG);
    if (!meeting && !hasType(e, FOLDER_DRAG)) return;
    if (!meeting && draggingFolder && folderSubtreeIds(draggingFolder).includes(folder.id)) {
      clearDropMarks(row); // sobre si mesma ou sobre uma descendente: não aceita
      return;
    }
    e.preventDefault();
    clearDropMarks(row);
    const zone = meeting ? 'into' : dropZone(e, row);
    row.classList.add(zone === 'into' ? 'drop-target' : `drop-${zone}`);
  };
  row.ondragleave = () => clearDropMarks(row);
  row.ondrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const zone = hasType(e, MEETING_DRAG) ? 'into' : dropZone(e, row);
    clearDropMarks(row);
    const dir = e.dataTransfer.getData(MEETING_DRAG);
    const dragged = e.dataTransfer.getData(FOLDER_DRAG);
    if (dir) await setFolderOf(dir, folder.id);
    else if (dragged) await dropFolderOn(dragged, folder, zone);
  };
  row.ondragstart = (e) => {
    draggingFolder = folder.id;
    document.body.classList.add('dragging-meeting'); // mostra a área "solte aqui para tirar da pasta"
    e.dataTransfer.setData(FOLDER_DRAG, folder.id);
    e.dataTransfer.effectAllowed = 'move';
  };
  row.ondragend = () => {
    draggingFolder = null;
    document.body.classList.remove('dragging-meeting');
    for (const marked of document.querySelectorAll('.drop-target, .drop-before, .drop-after')) clearDropMarks(marked);
  };
  block.append(row);
  if (!collapsed && expandable) {
    const children = [...subs.map((f) => buildFolderBlock(f, ctx)).filter(Boolean), ...kids.map((m) => buildMeetingItem(m, true))];
    block.append(build('div', { className: 'folder-children' }, children));
  }
  return block;
}

/** Linha de criação inline: input já focado; Enter cria, Esc ou vazio cancela. */
function startNewFolder() {
  if (document.querySelector('.folder-new')) return;
  editingList = true;
  const row = build('div', { className: 'folder-row folder-new' }, []);
  const input = build('input', { className: 'title-edit', placeholder: t('folder.new-ph'), autocomplete: 'off', maxLength: 60 }, []);
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    editingList = false;
    const name = input.value.trim();
    if (save && name) await createFolderNamed(name, null);
    else await refreshList();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(input.value.trim() !== '');
  row.append(build('span', { className: 'folder-ico' }, [window.RiceIcons.icon('folder')]), input);
  $('folders').prepend(row);
  input.focus();
}

async function refreshList() {
  if (editingList) return; // não destrói o input de renomear aberto na lista
  const [all, folders] = await Promise.all([window.rice.listMeetings(), window.rice.listFolders ? window.rice.listFolders() : []]);
  foldersCache = Array.isArray(folders) ? folders : [];
  lastMeetings = all;
  const known = new Set(foldersCache.map((f) => f.id));
  const meetings = all.filter(matchesSearch);
  const collapsed = readCollapsed();

  // seção PASTAS: cada pasta com as suas reuniões (as de fora ficam na lista por data, sem duplicar)
  const foldersBox = $('folders');
  foldersBox.replaceChildren();
  const searching = Boolean(searchQuery);
  for (const folder of subfoldersOf(null)) {
    const block = buildFolderBlock(folder, { meetings, collapsed, searching });
    if (block) foldersBox.append(block);
  }

  const list = $('list');
  list.replaceChildren();
  const unfiled = meetings.filter((m) => !m.folderId || !known.has(m.folderId));
  if (unfiled.length === 0 && !foldersCache.some((f) => meetings.some((m) => m.folderId === f.id))) {
    list.append(build('p', { className: 'empty group-label', textContent: all.length === 0 ? t('list.empty') : t('list.none-found') }, []));
  }
  for (const group of window.RiceGroup.groupByDay(unfiled, new Date())) {
    list.append(build('div', { className: 'group-label', textContent: group.label }, []));
    for (const m of group.items) list.append(buildMeetingItem(m));
  }
  list.append(build('div', { className: 'unfiled-hint', textContent: t('folder.drop-here') }, []));
  if (searchQuery && contentSearch() && !searchTimer) runSearch(); // a lista mudou (renomear, notas novas…): refaz os resultados
}

/** Input de título: Enter/blur salva, Esc cancela. `done(title)` recebe o título final ou null se cancelado. */
function titleInput(initial, className, done) {
  const input = build('input', { value: initial, className }, []);
  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    done(save && value && value !== initial ? value : null);
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
  return input;
}

async function applyRename(dir, title) {
  const result = await window.rice.renameMeeting(dir, title);
  if (!result.ok) setWarning(t('common.error', { message: result.message }));
  await refreshList();
  if (current === dir && !(recState !== 'idle' && recDir === dir)) await openMeeting(dir);
  else if (current === dir && result.ok && $('page-title')) $('page-title').textContent = result.title;
  return result;
}

/** Itens do menu ⋯ (reunião e lista): Renomear, Abrir no Finder e Apagar (desabilitado enquanto grava). */
/** Submenu "Mover para pasta ▸": as pastas (✓ na atual), "Nova pasta…" e "Remover da pasta" quando houver. */
function moveToFolderItems(dir, folderId) {
  const items = flattenFolders(null, 0).map(({ folder: f, level }) => ({
    icon: 'folder',
    label: f.name,
    indent: level,
    checked: f.id === folderId,
    onSelect: () => (f.id === folderId ? undefined : setFolderOf(dir, f.id)),
  }));
  if (items.length === 0) items.push({ label: t('menu.no-folders'), disabled: true, onSelect: () => {} });
  items.push({ separator: true }, { icon: 'folder-plus', label: t('menu.new-folder'), onSelect: () => askFolderName((name) => createFolderNamed(name, dir)) });
  if (folderId) items.push({ icon: 'plus', label: t('menu.unfile'), onSelect: () => setFolderOf(dir, null) });
  return items;
}

function meetingMenuItems(dir, title, rename, folderId) {
  const recording = isRecordingDir(dir);
  return [
    { icon: 'pencil', label: t('menu.rename'), onSelect: rename },
    { icon: 'folder', label: t('menu.reveal'), onSelect: () => window.rice.reveal(dir) },
    { icon: 'move', label: t('menu.move'), submenu: moveToFolderItems(dir, folderId) },
    { icon: 'share', label: t('share.menu'), submenu: window.RiceShare.items({ dir, hasNotes: (lastMeetings.find((m) => m.dir === dir) || {}).notesStatus === 'done', isDraft: (lastMeetings.find((m) => m.dir === dir) || {}).state === 'draft' }) },
    { icon: 'shield', label: t('receipt.menu'), onSelect: () => window.RiceReceipt.open(dir) },
    { separator: true },
    { icon: 'trash', label: t('menu.delete'), danger: true, disabled: recording, ...(recording ? { title: t('menu.delete-disabled') } : {}), onSelect: () => openDeleteDialog(dir, title) },
  ];
}

/** "⋯" da faixa superior: ações da reunião aberta. */
function renderMoreButton(dir, title) {
  const slot = $('more-slot');
  const btn = build('button', { className: 'icon-btn more-btn', type: 'button' }, []);
  btn.append(window.RiceIcons.icon('more'));
  btn.title = t('menu.more');
  btn.setAttribute('aria-label', t('menu.more'));
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.onclick = () =>
    window.RiceActionMenu.open({
      anchor: btn,
      items: meetingMenuItems(dir, title, () => {
        const heading = $('page-title');
        if (heading) heading.click(); // entra na edição do título
      }, (lastMeetings.find((m) => m.dir === dir) || {}).folderId),
    });
  slot.replaceChildren(btn);
}

function renameInList(item, m) {
  editingList = true;
  const input = titleInput(m.title, 'title-edit', (title) => {
    editingList = false;
    return title ? applyRename(m.dir, title) : refreshList();
  });
  item.replaceChildren(input);
  input.focus();
  input.select();
}

function editableTitle(dir, title) {
  const h1 = build('h1', { id: 'page-title', className: 'page-title', title: t('meeting.click-rename'), textContent: title }, []);
  const pencil = build('button', { className: 'pencil', title: t('meeting.rename') }, []);
  pencil.setAttribute('aria-label', t('meeting.rename'));
  pencil.append(window.RiceIcons.icon('pencil'));
  const row = build('div', { className: 'title-row' }, [h1, pencil]);
  const edit = () => {
    if (!h1.isConnected) return; // já editando
    const input = titleInput(h1.textContent, 'page-title title-edit', async (next) => {
      if (next) {
        const result = await applyRename(dir, next);
        if (result.ok) h1.textContent = result.title;
      }
      if (input.isConnected) row.replaceChildren(h1, pencil);
    });
    row.replaceChildren(input);
    input.focus();
    input.select();
  };
  h1.onclick = edit;
  pencil.onclick = edit;
  return row;
}

const SEGMENT_RE = /^\*\*\[(\d{2}:\d{2}:\d{2})\]\s+(.+?):\*\*\s*(.*)$/;
const GAP_RE = /^\*\[(.+)\]\*$/;

/** Nomes dados às pessoas da reunião aberta (`meta.speakers`) e os participantes da agenda, para o popover de renomear. */
let speakerNames = {};
let meetingParticipants = [];

/** "Pessoa 2" na transcrição: botão discreto que abre o popover para dar nome (vale para a reunião toda). */
function personLabel(raw) {
  const id = window.RiceI18n.personId(raw);
  const btn = build('button', { className: 't-who t-who-btn', type: 'button', textContent: window.RiceI18n.speaker(raw, speakerNames) }, []);
  btn.dataset.person = id;
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  btn.onclick = () => {
    const dir = current;
    window.RiceSpeakerPopover.open({
      anchor: btn,
      label: btn.textContent,
      name: speakerNames[id] || '',
      participants: meetingParticipants,
      suggest: async () => {
        const r = await window.rice.suggestSpeakerNames(dir);
        return r.ok && r.suggestions[id] ? [r.suggestions[id]] : [];
      },
      onSave: async (name) => {
        const r = await window.rice.setSpeakerName(dir, id, name);
        if (!r.ok) return setWarning(t('common.error', { message: r.message }));
        if (current !== dir) return;
        speakerNames = r.speakers;
        for (const node of document.querySelectorAll(`.t-who-btn[data-person="${id}"]`)) node.textContent = window.RiceI18n.speaker('Pessoa ' + id, speakerNames);
      },
    });
  };
  return btn;
}

function transcriptRow(line) {
  const seg = SEGMENT_RE.exec(line);
  if (seg) {
    const mine = window.RiceI18n.isMine(seg[2]);
    const person = window.RiceI18n.personId(seg[2]);
    return build('p', { className: 't-row ' + (mine ? 'me' : 'other'), title: seg[1] }, [
      person ? personLabel(seg[2]) : build('span', { className: 't-who', textContent: window.RiceI18n.speaker(seg[2]) }, []),
      build('span', { className: 't-text', textContent: seg[3] }, []),
    ]);
  }
  const gap = GAP_RE.exec(line);
  const attach = gap && /^(?:Anexo|Attachment): (.+)$/.exec(gap[1]);
  if (attach) {
    // anexo adicionado durante a gravação: marcador discreto no ponto da conversa em que entrou
    return build('p', { className: 't-row t-gap' }, [build('span', { className: 't-text t-attach' }, [window.RiceIcons.icon('paperclip'), build('span', { textContent: t('attach.marker', { name: attach[1] }) }, [])])]);
  }
  return build('p', { className: 't-row' + (gap ? ' t-gap' : '') }, [
    build('span', { className: 't-text', textContent: gap ? gap[1] : line }, []),
  ]);
}

function addTranscriptLines(text) {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('# ')) continue;
    renderedLines.add(line);
    transcriptNode.append(transcriptRow(line));
  }
}

/** Reunião interrompida (o Rice fechou antes do fim): uma linha discreta com a ação de recuperar. */
function recoverNote(dir) {
  const go = build('button', { type: 'button', textContent: t('recover.go') }, []);
  const note = build('div', { className: 'recover-note' }, [build('span', { textContent: t('recover.note') }, []), go]);
  go.onclick = async () => {
    go.disabled = true;
    go.textContent = t('recover.running');
    const result = await window.rice.recoverMeeting(dir);
    if (!result.ok) setWarning(t('recover.failed', { message: result.message }));
    refreshList();
    if (current === dir) openMeeting(dir);
  };
  return note;
}

/** Reunião com meta.json ilegível (R-52): uma página simples com a ação de reparar. */
function openDamaged(m) {
  current = m.dir;
  if (webSearch) webSearch.paint();
  view = 'meeting';
  setNav(null);
  const go = build('button', { type: 'button', className: 'primary', textContent: t('damaged.go') }, []);
  go.onclick = async () => {
    go.disabled = true;
    const result = await window.rice.repairMeeting(m.dir);
    if (!result.ok) setWarning(t('damaged.failed', { message: result.message }));
    refreshList();
    if (result.ok) openMeeting(m.dir);
    else go.disabled = false;
  };
  $('detail').replaceChildren(page(
    build('h1', { className: 'page-title static', textContent: m.title }, []),
    build('p', { className: 'hint', textContent: t('damaged.note') }, []),
    build('div', { className: 'damaged-actions' }, [go]),
  ));
}

function section(title, content) {
  return [build('h2', { textContent: title }, []), ...(Array.isArray(content) ? content : [content])];
}

const page = (...children) => build('div', { className: 'page' }, children);

function metaLine(meta) {
  const started = new Date(meta.startedAt);
  const parts = [
    started.toLocaleDateString(window.RiceI18n.locale(), { weekday: 'long', day: 'numeric', month: 'long' }) + ' · ' + started.toLocaleTimeString(window.RiceI18n.locale(), { hour: '2-digit', minute: '2-digit' }),
  ];
  const duration = window.RiceGroup.formatMeetingDuration(meta);
  if (duration) parts.push(duration);
  if (meta.state === 'interrupted') parts.push(t('meeting.interrupted'));
  if (meta.micName) parts.push(t('meeting.mic', { name: meta.micName })); // o microfone capturado (o último, se trocou no meio)
  return build('div', { className: 'page-meta' }, parts.map((text) => build('span', { textContent: text }, [])));
}

/** A lista de templates nunca impede abrir a reunião. */
const loadTemplates = async () => {
  try {
    return await window.rice.listTemplates();
  } catch {
    return { templates: [], defaultId: null, warnings: [] };
  }
};

let progressNode = null;

/** Linha discreta "Gerando notas… parte 2 de 6" acima das notas, só enquanto a geração roda. */
function drawProgress(dir) {
  if (!progressNode) return;
  const p = notesProgress.get(dir);
  const text = !p ? '' : p.phase === 'extract' ? t('notes.progress', { part: p.part, total: p.total }) : t('notes.progress.final');
  progressNode.textContent = text;
  progressNode.hidden = !text || current !== dir;
}

const effectiveTemplate = (data, list) => list.templates.find((t) => t.id === data.meta.templateId) || list.templates.find((t) => t.id === list.defaultId) || null;

/** Área "Notas": chip de template, banner de regerar, e o corpo (cartão do template sem notas; notas + link com notas). */
function notesArea(dir, data, list, generateAction) {
  let template = effectiveTemplate(data, list);
  const body = build('div', { className: 'notes-body' }, []);
  const progress = build('p', { className: 'notes-progress', hidden: true }, []);
  progressNode = progress;
  drawProgress(dir);
  const banner = build('div', { className: 'tpl-banner-host' }, []);
  const previewNode = () => (template ? window.RiceTemplatePreview.render(template) : build('p', { className: 'empty', textContent: t('notes.none-yet') }, []));
  let expanded = false;
  let emptyDetails = false; // "Ver detalhes" do estado vazio (recolhido por padrão)
  /** Sem notas ainda: uma linha, as seções como chips pequenos e "Ver detalhes" (que mostra as descrições). */
  const emptyNode = () => {
    if (!template) return build('p', { className: 'empty', textContent: t('notes.none-yet') }, []);
    const more = build('button', { type: 'button', className: 'link-button', textContent: t(emptyDetails ? 'notes.hide-details' : 'notes.details') }, []);
    more.setAttribute('aria-expanded', String(emptyDetails));
    more.onclick = () => {
      emptyDetails = !emptyDetails;
      drawBody();
    };
    const nodes = [
      build('p', { className: 'tpl-empty-line', textContent: t('notes.will-fill') }, []),
      build('div', { className: 'tpl-chips' }, template.sections.map((sec) => build('span', { className: 'tpl-sec-chip', textContent: sec.heading }, []))),
      more,
    ];
    if (emptyDetails) nodes.push(build('dl', { className: 'tpl-sec-details' }, template.sections.flatMap((sec) => [build('dt', { textContent: sec.heading }, []), build('dd', { textContent: sec.description || '' }, [])])));
    return build('div', { className: 'tpl-empty' }, nodes);
  };
  let viewing = null; // versão antiga em leitura (o notas.md atual não muda até "Restaurar esta")
  const drawBody = () => {
    if (viewing) return;
    if (!data.notes) return body.replaceChildren(emptyNode());
    const nodes = [build('div', { className: 'md' }, [mdNotes(data.notes)])];
    if (template) {
      const link = build('button', { className: 'link-button', textContent: t('notes.view-template') }, []);
      link.setAttribute('aria-expanded', String(expanded));
      link.onclick = () => {
        expanded = !expanded;
        drawBody();
      };
      nodes.push(link);
      if (expanded) nodes.push(build('div', { className: 'tpl-preview-host' }, [previewNode()]));
    }
    body.replaceChildren(...nodes);
  };
  drawBody();
  if (list.templates.length === 0) return [...(generateAction ? [build('div', { className: 'tpl-picker' }, [build('span', { className: 'tpl-right' }, [generateAction])])] : []), progress, body];
  const picker = window.RiceTemplatePicker.create({
    templates: list.templates,
    selectedId: template && template.id,
    onManage: showTemplates,
    onChoose: async (id) => {
      const previous = template;
      const result = await window.rice.setMeetingTemplate(dir, id);
      if (!result.ok) {
        setWarning(t('common.error', { message: result.message }));
        picker.setSelected(previous && previous.id);
        return;
      }
      template = list.templates.find((t) => t.id === id);
      drawBody();
      const busy = recState !== 'idle' && recDir === dir;
      if (data.notes && data.meta.notesStatus === 'done' && !busy) offerRegenerate(banner, dir, template);
      else banner.replaceChildren();
    },
  });
  // histórico de versões: o chip só aparece quando já existe alguma
  const versionsHost = build('span', { className: 'ver-host' }, []);
  const pickerRow = build('div', { className: 'tpl-picker' }, [picker.root, build('span', { className: 'tpl-right' }, [...(generateAction ? [generateAction] : []), versionsHost]), banner]); // uma linha de 32px: template à esquerda, versões à direita
  const drawVersions = async () => {
    if (!window.rice.notesVersions) return;
    const versions = await window.rice.notesVersions(dir).catch(() => []);
    if (!versionsHost.isConnected && !pickerRow.isConnected && current !== dir) return;
    if (versions.length === 0) return versionsHost.replaceChildren();
    const back = () => {
      viewing = null;
      drawBody();
      drawVersions();
    };
    versionsHost.replaceChildren(
      window.RiceVersions.chip({
        versions,
        currentTitle: template ? template.title : t('versions.current-untitled'),
        viewing: viewing && viewing.file,
        onCurrent: back,
        onView: async (version) => {
          const result = await window.rice.readNotesVersion(dir, version.file);
          if (!result.ok) return setWarning(t('common.error', { message: result.message }));
          viewing = result.version;
          body.replaceChildren(
            window.RiceVersions.strip({
              version: result.version,
              onBack: back,
              onRestore: async () => {
                const restored = await window.rice.restoreNotesVersion(dir, result.version.file);
                if (!restored.ok) return setWarning(t('common.error', { message: restored.message }));
                viewing = null;
                if (current === dir) openMeeting(dir);
              },
            }),
            build('div', { className: 'md' }, [md(result.content)]),
          );
          drawVersions();
        },
      }),
    );
  };
  drawVersions();
  return [pickerRow, progress, body];
}

/** Banner discreto abaixo do chip: regerar o resumo com o template escolhido, ou deixar como está. */
function offerRegenerate(banner, dir, template) {
  const dismiss = build('button', { textContent: t('regen.dismiss') }, []);
  const go = build('button', { className: 'primary', textContent: t('regen.go') }, []);
  dismiss.onclick = () => banner.replaceChildren();
  go.onclick = async () => {
    banner.replaceChildren();
    setWarning(t('regen.running', { title: template.title }));
    const result = await window.rice.regenerateNotes(dir, template.id);
    setWarning(result.ok ? '' : t('regen.failed', { message: result.message }));
    if (current === dir) openMeeting(dir);
  };
  banner.replaceChildren(
    build('div', { className: 'tpl-banner' }, [
      build('span', { textContent: t('regen.ask', { title: template.title }) }, []),
      build('span', { className: 'tpl-banner-actions' }, [go, dismiss]),
    ]),
  );
}

function setNav(active) {
  if (current === null) {
    openMeta = null;
    $('more-slot').replaceChildren();
  }
  $('home-link').classList.toggle('active', active === 'home');
  $('settings-link').classList.toggle('active', active === 'settings');
  $('guide-link').classList.toggle('active', active === 'guide');
  $('templates-link').classList.toggle('active', active === 'templates');
  $('followups-link').classList.toggle('active', active === 'followups');
  $('memory-link').classList.toggle('active', active === 'memory');
}

/** Aba escolhida por reunião (Notas · Transcrição · Ideias · Investigação), lembrada em localStorage (com try/catch). */
const MEETING_TABS_KEY = 'rice.meetingTabs';
function savedMeetingTab(dir) {
  try {
    return (JSON.parse(localStorage.getItem(MEETING_TABS_KEY) || '{}') || {})[dir] || null;
  } catch {
    return null;
  }
}
function rememberMeetingTab(dir, tab) {
  try {
    const all = JSON.parse(localStorage.getItem(MEETING_TABS_KEY) || '{}') || {};
    delete all[dir];
    all[dir] = tab;
    const keys = Object.keys(all);
    for (const old of keys.slice(0, Math.max(0, keys.length - 200))) delete all[old];
    localStorage.setItem(MEETING_TABS_KEY, JSON.stringify(all));
  } catch {
    // sem armazenamento: a escolha vale só enquanto a reunião está aberta
  }
}

/**
 * Abas de conteúdo da reunião, abaixo do título: Notas (com as anotações) · Transcrição · Ideias · e, no War room, Investigação (com o nº de achados por validar).
 * À direita, o chip do tipo da reunião (Reunião / War room). Devolve { node, draw }.
 */
function meetingTabs(dir, { notes, transcript, recording, hasNotes, metaNode, initialTab }) {
  let tab = initialTab || savedMeetingTab(dir) || (recording && !hasNotes ? 'transcript' : 'notes');
  const bar = build('div', { className: 'mt-bar' }, []);
  const body = build('div', { className: 'mt-body' }, []);
  const draw = (fromUpdate) => {
    if (current !== dir) return;
    const war = warRoom.isWar();
    const items = [['notes', t('meeting.tab.notes')], ['transcript', t('meeting.tab.transcript')], ['ideas', t('warroom.tab.ideas')], ['war', war && warRoom.unseen() > 0 && tab !== 'war' ? `${t('warroom.tab.war')} · ${warRoom.unseen()}` : t('warroom.tab.war')]];
    const tabsNode = build('div', { className: 'mt-tabs', role: 'tablist' }, items.map(([id, label]) => {
      const b = build('button', { type: 'button', className: 'mt-tab', textContent: label }, []);
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(id === tab));
      b.onclick = () => {
        tab = id;
        rememberMeetingTab(dir, id);
        draw();
      };
      return b;
    }));
    // selo "War room" ao lado da data (clicável: volta a ser reunião normal)
    metaNode.querySelector('.wr-badge')?.remove();
    if (war) {
      const badge = build('button', { type: 'button', className: 'wr-badge', textContent: t('warroom.kind.war'), title: t('warroom.badge.title') }, []);
      badge.onclick = () => warRoom.setKind('meeting');
      metaNode.append(badge);
    }
    bar.replaceChildren(tabsNode);
    const selected = tabsNode.querySelector('[aria-selected="true"]');
    if (selected && selected.scrollIntoView) selected.scrollIntoView({ block: 'nearest', inline: 'nearest' }); // em coluna estreita a aba escolhida nunca fica escondida
    // atualização vinda do War room (ciclo, ferramenta usada…) com Notas/Transcrição na tela: só a barra de abas muda; recolocar a transcrição inteira refaria o layout dela à toa
    if (fromUpdate === true && (tab === 'notes' || tab === 'transcript')) return;
    body.replaceChildren(...(tab === 'notes' ? notes : tab === 'transcript' ? [transcript] : warRoom.view(tab)));
    if (tab === 'war') warRoom.markSeen(); // o contador conta só os achados NOVOS desde a última vez que a aba foi vista
  };
  const show = (id) => {
    tab = id;
    draw();
  };
  return { node: build('div', { className: 'mt' }, [bar, body]), draw, show };
}

/** Ao sair da reunião atual (outra reunião, Início, Configurações…): se ela ficou vazia, o main a leva para a Lixeira em silêncio. */
function leaveMeeting(next) {
  if (current && current !== next && window.rice.discardEmptyDraft) window.rice.discardEmptyDraft(current).catch(() => {});
}

async function openMeeting(dir, opts = {}) {
  leaveMeeting(dir);
  current = dir;
  if (webSearch) webSearch.paint();
  if (!opts.keepScope && isGlobalScope()) {
    // abrir uma reunião pela lista volta o chat para ela; vindo de uma citação, o chat entre reuniões fica
    chatScope = { kind: 'meeting' };
    globalOpen = false;
  }
  view = 'meeting';
  setNav(null);
  opening = true;
  queuedSegments = [];
  let data;
  let templateList;
  let settings;
  try {
    [data, settings] = await Promise.all([window.rice.readMeeting(dir), window.rice.getSettings()]);
    // nome, descrição e seções dos embutidos aparecem no idioma do APP; as notas geradas seguem o idioma da reunião
    templateList = await loadTemplates();
  } finally {
    opening = false;
  }
  const running = window.rice.notesProgress ? await window.rice.notesProgress(dir).catch(() => null) : null;
  if (running) notesProgress.set(dir, running);
  else notesProgress.delete(dir);
  // leitura em Markdown; clicar edita no mesmo lugar. Salvar continua o mesmo IPC (só a apresentação mudou)
  const annotations = window.RiceAnnotations.create({
    value: data.annotations,
    onChange: (text) => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => window.rice.saveAnnotations(dir, text).then(() => annotations.markSaved()), 800);
    },
  });
  openAnnotations = annotations;
  openIsDraft = data.meta.state === 'draft';
  openIsRecorded = !openIsDraft;
  openMeta = data.meta; // antes do rótulo do botão (Continuar x Gravar depende da última sessão)
  renderRecLabel();
  renderMoreButton(dir, data.meta.title);
  openStartedAt = new Date(data.meta.startedAt);
  speakerNames = data.meta.speakers || {};
  meetingParticipants = data.meta.participants || [];
  transcriptNode = build('div', { className: 'transcript' }, []);
  renderedLines = new Set();
  partialRows = new Map();
  addTranscriptLines(data.transcript);
  await screens.setDir(dir, transcriptNode); // miniaturas no ponto do tempo; as notas só citam capturas desta lista
  if (current !== dir) return;
  const extras = [];
  let generateAction = null;
  if (!openIsDraft && data.meta.notesStatus !== 'done' && !(recState !== 'idle' && recDir === dir) && !(notesPending.has(dir) && data.transcript.includes('**[')) && !notesProgress.has(dir)) {
    // ação discreta ao lado do seletor de template (aba Notas), no mesmo estilo dos chips dali
    const gen = build('button', { type: 'button', className: 'tpl-chip gen-chip' }, [window.RiceIcons.icon('sparkles'), build('span', { textContent: t('notes.generate') }, [])]);
    gen.onclick = async () => {
      gen.disabled = true;
      gen.lastChild.textContent = t('notes.generating');
      const result = await window.rice.generateNotes(dir);
      if (!result.ok) setWarning(t('notes.failed', { message: result.message }));
      if (current === dir) openMeeting(dir);
    };
    generateAction = gen;
  }
  if (data.meta.state === 'interrupted' && !(recState !== 'idle' && recDir === dir) && window.rice.recoverMeeting) extras.push(recoverNote(dir));
  const metaNode = metaLine(data.meta);
  await warRoom.setDir(dir).catch(() => {}); // o tipo (Reunião / War room) decide as abas
  if (current !== dir) return;
  // ⌘V com imagem nas anotações vira anexo e deixa uma referência discreta no texto (a caixa de edição nasce ao clicar: o evento sobe até o corpo)
  annotations.body.addEventListener('paste', attachments.onPaste);
  attachDeps.onPasted = (name) => {
    const base = String(annotations.value || '').replace(/\s+$/, '');
    annotations.value = `${base}${base ? '\n' : ''}${t('attach.image-ref', { name })}\n`;
    window.rice.saveAnnotations(dir, annotations.value).then(() => annotations.markSaved());
  };
  document.body.dataset.attachDrop = t('attach.drop');
  attachments.setDir(dir);
  const memoryCard = window.RiceMemory.card({ rice: window.rice, dir, onOpen: (d) => openMeeting(d), onPerson: (kind, name) => showMemory({ kind, name }) }); // "O que lembrar": só aparece se houver fatos
  openMemoryCard = memoryCard;
  memoryCard.load();
  const tabs = meetingTabs(dir, {
    notes: [memoryCard.node, ...notesArea(dir, data, templateList, generateAction), annotations.heading, annotations.body, ...section(t('attach.title'), attachments.node)], // sem o rótulo "Notas" repetido: a aba já se chama assim
    transcript: transcriptNode,
    recording: recState !== 'idle' && recDir === dir,
    hasNotes: Boolean(data.notes),
    metaNode,
    initialTab: opts.tab,
  });
  $('detail').replaceChildren(page(
    editableTitle(dir, data.meta.title),
    metaNode,
    build('div', { className: 'page-actions' }, [...extras]),
    tabs.node,
  ));
  redrawMeeting = tabs.draw;
  tabs.draw();
  liveScroll.setActive(recState !== 'idle' && recDir === dir);
  renderLive();
  const queued = queuedSegments;
  queuedSegments = [];
  for (const item of queued) if (item.dir === dir) appendSegment(item.segment);
  if (resultsCtl) resultsCtl.setOpen(dir);
  if (opts.reveal) {
    // veio da busca: abre a aba do campo (notas/anotações ou transcrição), rola até o trecho e destaca
    const fields = Array.isArray(opts.reveal.field) ? opts.reveal.field : [opts.reveal.field];
    for (const field of fields) {
      tabs.show(field === 'transcript' ? 'transcript' : 'notes');
      if (window.RiceSearch.reveal($('detail'), { ...opts.reveal, field })) break;
    }
  }
  const messages = $('messages');
  messages.replaceChildren();
  for (const turn of data.chat) addTurn(turn.question, turn.answer, turn.sources);
  if (data.chat.length === 0) messages.append(build('p', { className: 'empty', textContent: t('chat.none') }, []));
  $('question').disabled = false;
  $('send').disabled = false;
  applyChat();
  refreshList();
}

/** Diálogo modal: todos seguem o mesmo padrão (`RiceDialog`: título, corpo e rodapé). `fill(box, close)` usa `box.body` e `box.foot`. Esc fecha. */
function openDialog(label, fill, opts) {
  return window.RiceDialog.open(label, fill, opts);
}

window.RiceShare.setup({ openDialog, warn: (message) => setWarning(t('common.error', { message })) });

function goHome() {
  leaveMeeting(null);
  current = null;
  if (webSearch) webSearch.paint();
  warRoom.setDir(null);
  attachments.setDir(null);
  openIsDraft = false;
  openIsRecorded = false;
  renderRecLabel();
  setNav(null);
  closeGuide();
  $('messages').replaceChildren(build('p', { className: 'empty', textContent: t('chat.open-first') }, []));
  $('question').disabled = true;
  $('send').disabled = true;
  applyChat();
}

async function removeMeeting(dir) {
  const result = await window.rice.deleteMeeting(dir);
  if (!result.ok) {
    setWarning(t('common.error', { message: result.message }));
    return;
  }
  if (current === dir) goHome();
  await refreshList();
}

/** A reunião `dir` está sendo gravada agora? (não dá para apagar) */
const isRecordingDir = (dir) => recState !== 'idle' && recDir === dir;

/** Diálogo de confirmação (digitar a palavra, "Mover para a Lixeira"): o mesmo de qualquer lugar de onde se apaga. */
function openDeleteDialog(dir, title) {
  if (isRecordingDir(dir)) {
    setWarning(t('menu.delete-disabled'));
    return;
  }
  const D = window.RiceDialog;
  openDialog(t('delete.dialog'), (box, close) => {
    const text = build('p', { textContent: t('delete.text', { title }) }, []);
    const cancel = D.button(t('common.cancel'), 'ghost', close);
    const next = D.button(t('delete.next'), 'primary', () => {
      const input = build('input', { placeholder: t('delete.placeholder', { word: t('delete.word') }), autocomplete: 'off' }, []);
      const final = D.button(t('delete.final'), 'danger');
      final.disabled = true;
      text.replaceChildren(t('delete.confirm-1'), build('code', { textContent: t('delete.word') }, []), t('delete.confirm-2'));
      input.oninput = () => {
        final.disabled = input.value.trim().toLowerCase() !== t('delete.word');
      };
      input.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (!final.disabled) final.click(); // Enter só confirma com a palavra certa
        }
      };
      final.onclick = async () => {
        if (final.disabled) return;
        close();
        await removeMeeting(dir);
      };
      box.foot.replaceChildren(cancel, final);
      box.body.append(input);
      input.focus();
    });
    box.body.append(text);
    box.foot.append(cancel, next);
  });
}

/** O que a área central mostra: início (próximas reuniões), tutorial ou uma reunião. */
let view = 'home';

let homeBox = null; // a página do Início que está na tela (re-renderizar o Início não pisca)

/** Nota do evento da agenda: o rascunho que já existe ou um novo (com o calendarEventId). */
async function draftFor(ev) {
  const existing = lastMeetings.find((m) => m.calendarEventId === ev.id && m.state === 'draft');
  return existing ? existing.dir : window.rice.createMeeting(ev.title, ev.id);
}

async function showHome() {
  view = 'home';
  if (current === null) setNav('home');
  const rice = window.rice;
  const args = {
    now: new Date(),
    onJoin: (ev) => rice.openLink(ev.joinUrl),
    onNotes: async (ev) => openMeeting(await draftFor(ev)),
    // grava já na nota do evento (a mesma do "Preparar notas", se existir) e abre a reunião
    onRecord: async (ev) => {
      if (recState !== 'idle') return;
      const result = await rice.startRecording({ title: ev.title, dir: await draftFor(ev) });
      if (!result.ok) return setWarning(t('common.error', { message: result.message }));
      recDir = result.dir;
      markRecorded(result.dir);
      await openMeeting(result.dir);
    },
    recording: recState !== 'idle',
    onConnect: () => showSettings('calendar'),
    onNewWarRoom: newWarRoom,
    onPerson: (kind, name) => showMemory({ kind, name }),
    onMemory: (ev) => (rice.memoryBriefEvent ? rice.memoryBriefEvent(ev.id).catch(() => null) : Promise.resolve(null)),
    onAsk: (question) => {
      setScope({ kind: 'all' }, true);
      askGlobal(question);
    },
  };
  // esqueleto síncrono (título e campo de pergunta) para a tela nunca ficar em branco; a agenda chega depois, no lugar
  let box = homeBox && homeBox.isConnected ? homeBox : null;
  if (!box) {
    box = build('div', { className: 'page' }, []);
    window.RiceHome.render(box, { ...args, events: [], google: { connected: true }, connected: true, loading: true });
    $('detail').replaceChildren(box);
    homeBox = box;
  }
  const [events, google, eventKit] = await Promise.all([
    rice.calendarEvents ? rice.calendarEvents().catch(() => []) : [],
    rice.googleStatus ? rice.googleStatus().catch(() => ({ connected: true })) : { connected: true },
    rice.eventKitStatus ? rice.eventKitStatus().catch(() => ({ access: 'unknown' })) : { access: 'unknown' },
  ]);
  if (view !== 'home' || !box.isConnected) return; // o usuário abriu outra coisa enquanto carregava
  window.RiceHome.render(box, { ...args, events, google, connected: Boolean(google.connected) || eventKit.access === 'granted' }); // qualquer fonte de agenda: Google ou Calendário do macOS
  renderLive();
  loadHomeAiState(box);
  loadHomeReminders(box);
}

/** "Para hoje": lembretes do macOS, buscados depois de desenhar a página (só locais, nunca vão para a IA). */
async function loadHomeReminders(box) {
  if (!window.rice.remindersList) return;
  let state;
  try {
    state = await window.rice.remindersList();
  } catch {
    return;
  }
  if (view !== 'home' || !box.isConnected) return;
  window.RiceHome.applyReminders(box, state, {
    onComplete: async (item) => {
      const r = await window.rice.remindersComplete(item.id);
      return Boolean(r && r.ok);
    },
    onAllow: async (access) => {
      if (access === 'denied') return window.rice.openRemindersPrivacy();
      await window.rice.remindersRequest(); // a resposta chega por 'reminders:changed'
    },
  });
}
window.rice.on('reminders:changed', () => {
  if (view !== 'home') return;
  const box = $('detail').querySelector('.page');
  if (box) loadHomeReminders(box);
});

/** Estado da IA para o Início: busca depois de desenhar a página (a detecção das CLIs pode demorar). */
async function loadHomeAiState(box) {
  if (!window.rice.aiStatus) return;
  let status;
  try {
    status = await window.rice.aiStatus();
  } catch {
    return;
  }
  if (view !== 'home' || !box.isConnected) return;
  const active = status.providers && status.providers[status.active];
  const free = (status.models && status.models['opencode-sub']) || '';
  window.RiceHome.applyAiState(box, {
    needsSetup: !active || !active.connected,
    freeModel: status.active === 'opencode-sub' && /^opencode\/.*(big-pickle|free)$|:free$/i.test(free),
  }, () => openAiSettings(status.active));
}

/** "Configurar" / "Trocar modelo": abre Configurações na seção Inteligência artificial, com o provedor sugerido já aberto. */
async function openAiSettings(provider) {
  if (window.RiceAiProviders) window.RiceAiProviders.markLoginError(provider);
  await showSettings('ai');
}

function closeGuide() {
  return showHome();
}

/** Página "Pendências": o que prometi e o que prometeram a mim, de todas as reuniões. */
function showFollowups() {
  leaveMeeting(null);
  current = null;
  if (webSearch) webSearch.paint();
  warRoom.setDir(null);
  attachments.setDir(null);
  view = 'followups';
  openIsDraft = false;
  openIsRecorded = false;
  renderRecLabel();
  setNav('followups');
  $('messages').replaceChildren(build('p', { className: 'empty', textContent: t('chat.open-first') }, []));
  $('question').disabled = true;
  $('send').disabled = true;
  applyChat();
  const box = build('div', { className: 'page' }, []);
  $('detail').replaceChildren(box);
  refreshList();
  return followupsPage.render(box);
}
$('followups-link').onclick = () => showFollowups();

/** Página "Memória": pessoas e empresas que o Rice lembra; `target` ({ kind, name }) abre direto o detalhe. */
function showMemory(target) {
  leaveMeeting(null);
  current = null;
  if (webSearch) webSearch.paint();
  warRoom.setDir(null);
  attachments.setDir(null);
  view = 'memory';
  openIsDraft = false;
  openIsRecorded = false;
  renderRecLabel();
  setNav('memory');
  $('messages').replaceChildren(build('p', { className: 'empty', textContent: t('chat.open-first') }, []));
  $('question').disabled = true;
  $('send').disabled = true;
  applyChat();
  const box = build('div', { className: 'page' }, []);
  $('detail').replaceChildren(box);
  refreshList();
  return memoryPage.render(box, target);
}
$('memory-link').onclick = () => showMemory();

/** Contador discreto das minhas pendências vencidas, ao lado de "Pendências" na barra lateral. */
async function refreshFollowupsBadge() {
  const badge = $('followups-badge');
  if (!window.rice.followupsCount) return;
  const r = await window.rice.followupsCount().catch(() => null);
  const n = r ? r.overdue : 0;
  badge.hidden = !n;
  badge.textContent = n ? String(n) : '';
  badge.title = n ? window.RiceI18n.tn('followups.badge.title', n) : '';
}
let openMemoryCard = null; // cartão "O que lembrar" da reunião aberta
window.rice.on('memory:changed', () => {
  refreshFollowupsBadge();
  if (view === 'followups') followupsPage.refresh();
  if (view === 'memory') memoryPage.refresh();
  if (openMemoryCard) openMemoryCard.refresh();
});
window.rice.on('app:open-followups', () => showFollowups());
refreshFollowupsBadge();
window.addEventListener('rice:memory-changed', refreshFollowupsBadge);

function showGuide(focus) {
  leaveMeeting(null);
  current = null;
  if (webSearch) webSearch.paint();
  warRoom.setDir(null);
  attachments.setDir(null);
  view = 'guide';
  openIsDraft = false;
  openIsRecorded = false;
  renderRecLabel();
  setNav('guide');
  $('question').disabled = true;
  $('send').disabled = true;
  $('rec-bar').hidden = false;
  applyChat();
  const box = build('div', { className: 'page' }, []);
  $('detail').replaceChildren(box);
  const rendered = window.RiceGuide.render(box, { onClose: closeGuide, focus: typeof focus === 'string' ? focus : undefined, confirm: confirmDialog, onChatToolsChange: refreshAiVia, onNewWarRoom: newWarRoom });
  refreshList();
  return rendered;
}

$('guide-link').onclick = () => showGuide();
$('home-link').onclick = () => goHome();

function confirmDialog(message, label) {
  return new Promise((resolve) => {
    const D = window.RiceDialog;
    let answered = false;
    const answer = (value) => {
      if (answered) return;
      answered = true;
      resolve(value);
    };
    openDialog(t('common.confirm'), (box, close) => {
      for (const line of Array.isArray(message) ? message : [message]) box.body.append(build('p', { textContent: line }, []));
      box.foot.append(
        D.button(t('common.cancel'), 'ghost', () => {
          answer(false);
          close();
        }),
        D.button(label, 'danger', () => {
          answer(true); // antes de fechar: o fechamento (Esc incluso) conta como "não" se ninguém respondeu
          close();
        }),
      );
      return () => answer(false); // Esc também fecha: conta como "não"
    });
  });
}

function showTemplates(tab) {
  leaveMeeting(null);
  current = null;
  if (webSearch) webSearch.paint();
  warRoom.setDir(null);
  attachments.setDir(null);
  view = 'templates';
  openIsDraft = false;
  openIsRecorded = false;
  renderRecLabel();
  setNav('templates');
  $('messages').replaceChildren(build('p', { className: 'empty', textContent: t('chat.open-first') }, []));
  $('question').disabled = true;
  $('send').disabled = true;
  applyChat();
  const box = build('div', { className: 'page' }, []);
  $('detail').replaceChildren(box);
  const rendered = window.RiceTemplates.render(box, { confirm: confirmDialog, onError: (message) => setWarning(t('common.error', { message })), tab: tab === 'ideas' ? 'ideas' : undefined });
  refreshList();
  return rendered;
}

$('templates-link').onclick = () => showTemplates();

/** Painel "Pergunte ao Rice": preferência lembrada; sem reunião aberta fica recolhido. */
const CHAT_PREF_KEY = 'rice.chatOpen';

function readChatPref() {
  try {
    const raw = localStorage.getItem(CHAT_PREF_KEY);
    return raw === null ? null : raw === '1';
  } catch {
    return null;
  }
}

function writeChatPref(open) {
  try {
    localStorage.setItem(CHAT_PREF_KEY, open ? '1' : '0');
  } catch {
    // sem armazenamento: vale só nesta sessão
  }
}

let chatPref = readChatPref();

/** "Buscar na web" do chat (criado mais abaixo): ligado por conversa, só para as perguntas feitas com ele ligado. */
let webSearch = null;
const webOn = () => webSearch !== null && webSearch.isOn();
/** Bolha da pergunta com o ⋯ (aparece ao passar o mouse ou focar): "Salvar como pergunta pronta". */
function userBubble(question) {
  const more = build('button', { type: 'button', className: 'msg-more' }, [window.RiceIcons.icon('more')]);
  more.title = t('chat.prompts.msg-more');
  more.setAttribute('aria-label', t('chat.prompts.msg-more'));
  more.setAttribute('aria-haspopup', 'menu');
  more.onclick = () => {
    const can = promptChips ? promptChips.canSave(question) : { ok: false, reason: '' };
    window.RiceActionMenu.open({ anchor: more, items: [{ label: t('chat.prompts.save'), icon: 'plus', disabled: !can.ok, ...(can.reason ? { title: can.reason } : {}), onSelect: () => promptChips.save(question) }] });
  };
  const bubble = build('p', { className: 'msg user' }, [question, more]);
  bubble.dataset.question = question; // "Salvar a última pergunta" do menu de perguntas prontas
  return bubble;
}

/** Perguntas prontas abaixo do campo (criadas mais abaixo); só aparecem com o chat da vez vazio. */
let promptChips = null;
const openWebSource = (url) => {
  if (window.RiceWebSearch.safeUrl(url)) window.rice.openLink(url);
};

/** Escopo do chat: a reunião aberta, todas as reuniões ou uma pasta (o chat entre reuniões). */
let chatScope = { kind: 'meeting' };
let globalOpen = false;
let globalLoading = null;
let globalBusy = false;
let wasGlobal = false;
const isGlobalScope = () => chatScope.kind !== 'meeting';

function chatIsOpen() {
  return isGlobalScope() ? globalOpen : current !== null && chatPref !== false;
}

function scopeLabel() {
  // rótulo curto no chip (o nome completo fica no tooltip e no menu)
  if (chatScope.kind === 'all') return t('gchat.chip.all');
  if (chatScope.kind === 'folder') return t('gchat.scope.folder', { name: folderPath(chatScope.folderId) });
  return t('gchat.scope.meeting');
}

function applyChat() {
  const open = chatIsOpen();
  const global = isGlobalScope();
  document.body.classList.toggle('chat-open', open);
  if (!open) document.body.classList.remove('side-open'); // o chat fechou: a sidebar volta ao normal
  const toggle = $('chat-toggle');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.disabled = false;
  $('messages').hidden = global;
  $('messages-global').hidden = !global;
  $('gchat-new').hidden = !global;
  $('scope-label').textContent = scopeLabel();
  $('scope-chip').title = chatScope.kind === 'all' ? t('gchat.scope.all') : chatScope.kind === 'folder' ? t('gchat.scope.folder', { name: folderPath(chatScope.folderId) }) : t('gchat.scope-title');
  $('scope-chip').replaceChildren($('scope-label'), window.RiceIcons.caret());
  $('question').placeholder = global ? t('gchat.placeholder') : t('chat.placeholder');
  $('question').setAttribute('aria-label', $('question').placeholder);
  if (global) {
    $('question').disabled = false;
    $('send').disabled = globalBusy;
  } else if (wasGlobal) {
    $('question').disabled = current === null;
    $('send').disabled = current === null;
  }
  wasGlobal = global;
  if (webSearch) webSearch.paint();
}

/** Abre o citado e destaca onde as palavras da pergunta aparecem (notas, senão transcrição); o chat entre reuniões continua aberto. */
function openCitation(citation, terms) {
  openMeeting(citation.dir, { keepScope: true, reveal: { terms: terms || [], field: ['notes', 'transcript'] } });
}

function renderGlobalTurn(box, turn) {
  const message = build('div', { className: 'msg rice' }, [build('div', { className: 'md' }, [])]);
  box.append(userBubble(turn.question), message);
  window.RiceGlobalChat.fillAnswer(message.lastChild, message, md(turn.answer), turn.citations || [], (c) => openCitation(c, turn.terms));
  const web = window.RiceWebSearch.sourcesBox(turn.sources, openWebSource);
  if (web) message.append(web);
}

function showGlobalEmpty() {
  $('messages-global').replaceChildren(build('p', { className: 'empty', textContent: t('gchat.empty') }, []));
}

/** Lê a conversa salva uma vez; quem for escrever na lista espera esta promessa, para o histórico não apagar a pergunta nova. */
function loadGlobalHistory() {
  if (!globalLoading) globalLoading = readGlobalHistory();
  return globalLoading;
}

async function readGlobalHistory() {
  if (!window.rice.globalHistory) return;
  let turns = [];
  try {
    turns = await window.rice.globalHistory();
  } catch {
    turns = [];
  }
  const box = $('messages-global');
  box.replaceChildren();
  for (const turn of turns) renderGlobalTurn(box, turn);
  if (turns.length === 0) showGlobalEmpty();
  box.scrollTop = box.scrollHeight;
}

function setScope(scope, focus) {
  chatScope = scope;
  if (isGlobalScope()) {
    globalOpen = true;
    loadGlobalHistory();
  } else if (current !== null) {
    chatPref = true;
    writeChatPref(true);
  }
  applyChat();
  if (focus) $('question').focus();
}

$('scope-chip').onclick = () => {
  const folderItems = flattenFolders(null, 0).map(({ folder: f, level }) => ({
    icon: 'folder',
    label: f.name,
    indent: level,
    checked: chatScope.kind === 'folder' && chatScope.folderId === f.id,
    onSelect: () => setScope({ kind: 'folder', folderId: f.id }, true),
  }));
  window.RiceActionMenu.open({
    anchor: $('scope-chip'),
    items: [
      { icon: 'file-text', label: t('gchat.scope.meeting'), checked: chatScope.kind === 'meeting', disabled: current === null, onSelect: () => setScope({ kind: 'meeting' }, true) },
      { icon: 'message-circle', label: t('gchat.scope.all'), checked: chatScope.kind === 'all', onSelect: () => setScope({ kind: 'all' }, true) },
      ...(folderItems.length > 0 ? [{ separator: true }, ...folderItems] : []),
    ],
  });
};

$('gchat-new').onclick = async () => {
  await window.rice.newGlobalChat();
  if (webSearch) webSearch.reset('global'); // conversa nova começa com a busca desligada
  showGlobalEmpty();
  $('question').focus();
};

/** Chat por cima (janela estreita): clicar no fundo escurecido, no botão de fechar ou apertar Esc fecha o painel. */
const closeChatOverlay = () => {
  if (document.body.classList.contains('chat-open') && getComputedStyle($('chat-scrim')).display !== 'none') $('chat-toggle').click();
};
$('chat-scrim').onclick = closeChatOverlay;
$('chat-close').onclick = () => $('chat-toggle').click();
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role=dialog], .menu-popover, .action-menu')) closeChatOverlay();
});

$('chat-toggle').onclick = () => {
  if (isGlobalScope()) globalOpen = !globalOpen;
  else if (current === null) return setScope({ kind: 'all' }, true);
  else {
    chatPref = !chatIsOpen();
    writeChatPref(chatPref);
  }
  applyChat();
  if (chatIsOpen()) $('question').focus();
};

/** Tecla de atalho: ⌘ no Mac, Ctrl no Windows (titlebar.js define RiceKeys; sem ele, ⌘). */
const modKey = (e) => (window.RiceKeys ? window.RiceKeys.mod(e) : e.metaKey);

/** ⌘J: abre o chat de todas as reuniões, de qualquer tela. */
const onGlobalChatShortcut = (e) => {
  if (!(modKey(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j')) return;
  e.preventDefault();
  setScope(isGlobalScope() ? chatScope : { kind: 'all' }, true);
};
if (window.__riceGlobalChatShortcut) document.removeEventListener('keydown', window.__riceGlobalChatShortcut);
window.__riceGlobalChatShortcut = onGlobalChatShortcut;
document.addEventListener('keydown', onGlobalChatShortcut);

/** Indicador discreto de espera (três pontos + texto) até o primeiro trecho da resposta. */
function thinkingNode(label) {
  const dots = build('span', { className: 'dots' }, [build('i', {}, []), build('i', {}, []), build('i', {}, [])]);
  const node = build('span', { className: 'thinking' }, [dots, build('span', { className: 'thinking-label', textContent: label }, [])]);
  node.setAttribute('role', 'status');
  return node;
}

// botão de enviar vira "parar" (quadrado) enquanto a resposta é gerada
let stopChatId = null;
let userStopped = false;
function setSendStop(on, id) {
  const btn = $('send');
  stopChatId = on ? id : null;
  userStopped = false;
  btn.dataset.stop = on ? '1' : '';
  btn.replaceChildren(window.RiceIcons.icon(on ? 'square' : 'arrow-up'));
  const label = on ? t('chat.stop') : t('chat.send');
  btn.title = label;
  btn.setAttribute('aria-label', label);
  if (on) btn.disabled = false;
}
$('send').addEventListener('click', (e) => {
  if ($('send').dataset.stop !== '1') return;
  e.preventDefault();
  userStopped = true;
  window.rice.cancel(stopChatId);
});

function addTurn(question, answer, sources) {
  const messages = $('messages');
  messages.querySelector('.empty')?.remove();
  const answerNode = build('div', { className: 'md' }, answer ? [md(answer)] : []);
  messages.append(
    userBubble(question),
    build('div', { className: 'msg rice' }, [answerNode]),
  );
  const web = window.RiceWebSearch.sourcesBox(sources, openWebSource); // histórico: as fontes da busca voltam junto da resposta
  if (web) messages.lastElementChild.append(web);
  messages.scrollTop = messages.scrollHeight;
  return answerNode;
}

// pergunta feita pelo nub durante a gravação: aparece também aqui
window.rice.on('chat:external', ({ dir, question, answer }) => {
  if (dir === current) addTurn(question, answer);
});

window.rice.onDelta((id, text) => {
  if (id !== chatId) return;
  if (!streamNode) return;
  streamRaw += text;
  streamNode.classList.add('streaming'); // o textContent abaixo troca o indicador "Pensando…" pelo primeiro trecho
  streamNode.textContent = streamRaw;
});

/** Erro de login do provedor ativo: na próxima vez que a lista de IAs abrir, o detalhe dele já vem aberto. */
function noteLoginError(result) {
  if (result && result.kind === 'auth' && window.RiceAiProviders) window.RiceAiProviders.markLoginError($('ai-via').dataset.provider || null);
}

async function askGlobal(question) {
  await loadGlobalHistory();
  const box = $('messages-global');
  box.querySelector('.empty')?.remove();
  $('question').value = '';
  fitQuestion();
  globalBusy = true;
  if (aiChip) aiChip.setBusy(true);
  const id = ++chatId;
  setSendStop(true, id);
  const answerNode = build('div', { className: 'md streaming' }, [thinkingNode(t('chat.searching'))]);
  const toThinking = setTimeout(() => {
    const label = answerNode.querySelector('.thinking-label');
    if (label && streamRaw === '') label.textContent = t('chat.thinking');
  }, 1500);
  const message = build('div', { className: 'msg rice' }, [answerNode]);
  box.append(userBubble(question), message);
  box.scrollTop = box.scrollHeight;
  streamNode = answerNode;
  streamRaw = '';
  const scope = chatScope.kind === 'folder' ? { kind: 'folder', folderId: chatScope.folderId } : { kind: 'all' };
  let result;
  try {
    result = await window.rice.askGlobal(id, question, scope, webOn());
  } catch (err) {
    result = { ok: false, message: String((err && err.message) || err) };
  }
  clearTimeout(toThinking);
  const stopped = userStopped;
  setSendStop(false);
  streamNode = null;
  answerNode.classList.remove('streaming');
  if (stopped && !result.ok) answerNode.textContent = streamRaw ? `${streamRaw}\n\n${t('chat.stopped')}` : t('chat.stopped');
  else if (result.ok) {
    window.RiceGlobalChat.fillAnswer(answerNode, message, md(result.answer), result.citations || [], (c) => openCitation(c, result.terms));
    const web = window.RiceWebSearch.sourcesBox(result.sources, openWebSource);
    if (web) message.append(web);
  }
  else {
    answerNode.textContent = result.message;
    noteLoginError(result);
  }
  globalBusy = false;
  if (aiChip) aiChip.setBusy(false);
  $('send').disabled = !isGlobalScope();
  box.scrollTop = box.scrollHeight;
}

/** Campo de pergunta: cresce de 1 a 5 linhas; Enter envia e Shift+Enter quebra a linha. */
function fitQuestion() {
  const box = $('question');
  box.style.height = 'auto';
  box.style.height = `${Math.min(box.scrollHeight, 110)}px`;
}
$('question').addEventListener('input', fitQuestion);
$('question').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!$('send').disabled && $('send').dataset.stop !== '1') $('ask').requestSubmit();
  }
});

$('ask').onsubmit = async (event) => {
  event.preventDefault();
  if ($('send').dataset.stop === '1') return; // gerando: o botão é o de parar
  const question = $('question').value.trim();
  if (isGlobalScope()) {
    if (question && !globalBusy) await askGlobal(question);
    return;
  }
  if (!question || !current) return;
  $('question').value = '';
  fitQuestion();
  if (aiChip) aiChip.setBusy(true);
  const id = ++chatId;
  setSendStop(true, id);
  const node = addTurn(question, '');
  node.append(thinkingNode(t('chat.thinking')));
  streamNode = node;
  streamRaw = '';
  const result = await window.rice.ask(id, current, question, webOn());
  const stopped = userStopped;
  setSendStop(false);
  streamNode = null;
  node.classList.remove('streaming');
  if (stopped && !result.ok) {
    node.textContent = streamRaw ? `${streamRaw}\n\n${t('chat.stopped')}` : t('chat.stopped');
  } else if (result.ok) {
    if (streamRaw) node.replaceChildren(md(streamRaw));
    else node.replaceChildren();
    const web = window.RiceWebSearch.sourcesBox(result.sources, openWebSource);
    if (web) node.parentElement.append(web);
  } else {
    node.textContent = result.message; // já vem amigável (pt-BR) do provedor ativo
    noteLoginError(result);
  }
  $('send').disabled = false;
  if (aiChip) aiChip.setBusy(false);
};

function pad(n) {
  return String(n).padStart(2, '0');
}

function clock(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function setTransient(key, text) {
  status[key] = text;
  renderStatus();
  clearTimeout(clearTimers[key]);
  if (text) {
    clearTimers[key] = setTimeout(() => {
      status[key] = '';
      renderStatus();
    }, 10000);
  }
}

function setWarning(text) {
  setTransient('warning', text);
}

function showPartial({ source, segmentId, text, startMs }) {
  if (!transcriptNode || !openStartedAt) return;
  const at = new Date(openStartedAt.getTime() + startMs);
  const mine = window.RiceI18n.isMine(source);
  const row = build('p', { className: 't-row t-partial ' + (mine ? 'me' : 'other'), title: clock(at) }, [
    build('span', { className: 't-who', textContent: window.RiceI18n.speaker(source) }, []),
    build('span', { className: 't-text', textContent: text.trim() }, []),
  ]);
  row.dataset.segmentId = segmentId;
  const old = partialRows.get(source);
  if (old) clearTimeout(old.expiry);
  // final vazio/alucinação não gera evento: o parcial some sozinho se parar de ser atualizado
  row.expiry = setTimeout(() => {
    if (partialRows.get(source) === row) partialRows.delete(source);
    row.remove();
  }, 6000);
  partialRows.set(source, row);
  liveScroll.follow(() => {
    if (old) old.remove();
    transcriptNode.append(row);
  });
}

function appendSegment(segment) {
  if (!transcriptNode || !openStartedAt) return;
  for (const [who, row] of partialRows) {
    if (segment.segmentId && row.dataset.segmentId === segment.segmentId) {
      clearTimeout(row.expiry);
      row.remove();
      partialRows.delete(who);
    }
  }
  if (segment.speaker && segment.speakerName && !speakerNames[segment.speaker]) speakerNames = { ...speakerNames, [segment.speaker]: segment.speakerName }; // nome da chamada (Discord): o main já gravou no meta
  const at = new Date(openStartedAt.getTime() + segment.startMs);
  const who = segment.source === 'Outros' && segment.speaker ? `Pessoa ${segment.speaker}` : segment.source;
  const line = `**[${clock(at)}] ${who}:** ${segment.text.trim()}`;
  if (renderedLines.has(line)) return;
  liveScroll.follow(() => {
    addTranscriptLines(line);
    // parciais de outros trechos continuam abertos: mantém no fim
    for (const row of partialRows.values()) transcriptNode.append(row);
  });
}

function renderStatus() {
  // download e captura guardam funções: o texto é refeito no idioma atual a cada renderização
  const parts = [status.download, status.asr, status.capture, status.warning].map((v) => (typeof v === 'function' ? v() : v)).filter(Boolean);
  $('status').textContent = parts.join(' · ');
  $('retry').hidden = !status.asrFailed;
}

/** A reunião aberta passou a ter gravação (a adotada era um rascunho): o rótulo já vira "Continuar gravação". */
function markRecorded(dir) {
  if (dir !== current) return;
  openIsDraft = false;
  openIsRecorded = true;
  renderRecLabel();
}

/** Chip único de idioma do topo: o mesmo em todas as telas; o menu em árvore troca o idioma do app e o das reuniões. */
let langMenu = null;
/** `meta` da reunião aberta (null fora de uma reunião). */
let openMeta = null;

async function langState() {
  const settings = await window.rice.getSettings();
  const inMeeting = current !== null && openMeta !== null;
  const defaultLanguage = settings.transcriptionLanguage || 'pt';
  return {
    ui: window.RiceI18n.getLanguage(),
    defaultLanguage,
    meetingLanguage: inMeeting ? openMeta.language || defaultLanguage : null,
    locked: recState !== 'idle' && recDir === current, // gravando: o idioma desta reunião não muda até a próxima
  };
}

function renderLangChip() {
  if (!langMenu) {
    langMenu = window.RiceLanguageMenu.create({
      getState: langState,
      on: {
        app: async (ui) => {
          const result = await window.rice.setUiLanguage(ui);
          if (!result.ok) setWarning(t('common.error', { message: result.message }));
        },
        defaultLanguage: async (language) => {
          const result = await window.rice.setTranscriptionLanguage(language);
          if (!result.ok) setWarning(t('common.error', { message: result.message }));
        },
        meeting: async (language) => {
          const dir = current;
          const result = await window.rice.setMeetingLanguage(dir, language);
          if (!result.ok) return setWarning(t('common.error', { message: result.message }));
          if (current === dir) {
            await openMeeting(dir); // os nomes das seções do template seguem o idioma da reunião
            $('lang-chip').focus();
          }
        },
        more: () => showSettings(),
      },
    });
    $('lang-slot').replaceChildren(langMenu.root);
  }
  langMenu.redraw();
}

// reunião em andamento: tempo decorrido, item fixo na barra lateral, cartão no Início e o botão da faixa levando até ela
let recStartedAt = 0;
/** Gravação pausada: o tempo parado não conta no relógio. */
let recPaused = false;
let pausedSince = 0;
let pausedTotal = 0;
let liveTimer = null;
/** Gravando uma reunião que não é a aberta agora: o botão da faixa vira "tempo · Abrir reunião". */
const liveAway = () => recState === 'recording' && Boolean(recDir) && current !== recDir;
function elapsedText() {
  const total = Math.max(0, Math.floor((Date.now() - recStartedAt - pausedTotal - (recPaused ? Date.now() - pausedSince : 0)) / 1000));
  const two = (n) => String(n).padStart(2, '0');
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}` : `${two(Math.floor(total / 60))}:${two(total % 60)}`;
}
function liveTitle() {
  const known = lastMeetings.find((m) => m.dir === recDir);
  return (current === recDir && openMeta && openMeta.title) || (known && known.title) || t('meeting.default-title');
}
function renderLive() {
  const on = recState === 'recording' && Boolean(recDir);
  const item = $('live-item');
  item.hidden = !on;
  if (on) {
    const label = t(recPaused ? 'live.item-paused' : 'live.item', { title: liveTitle(), time: elapsedText() }); // pausado: "Pausado · título · 00:18" (o relógio está parado)
    const text = item.querySelector('.live-text');
    if (text) {
      if (text.textContent !== label) text.textContent = label; // a cada segundo só o texto muda (sem recriar o ponto nem o botão)
    } else {
      item.replaceChildren(build('span', { className: 'live-dot' }, []), build('span', { className: 'live-text', textContent: label }, []));
    }
    const dot = item.querySelector('.live-dot');
    if (dot) dot.classList.toggle('paused', recPaused);
    if (item.title !== label) item.title = label;
    item.classList.toggle('active', current === recDir);
  }
  const home = $('detail').querySelector('.live-card');
  if (home && !on) home.remove();
  if (home && on) {
    home.querySelector('.live-card-text').textContent = `${liveTitle()} · ${elapsedText()}`;
    home.querySelector('.live-dot').classList.toggle('paused', recPaused);
    home.querySelector('small').textContent = t(recPaused ? 'rec.paused' : 'live.in-progress');
  }
  if (!home && on && view === 'home') {
    const box = $('detail').querySelector('.page');
    if (box) box.prepend(liveCard());
  }
}
function liveCard() {
  const open = build('button', { type: 'button', textContent: t('live.open-short') }, []);
  open.onclick = () => recDir && openMeeting(recDir);
  return build('div', { className: 'live-card' }, [
    build('span', { className: 'live-dot' + (recPaused ? ' paused' : '') }, []),
    build('div', { className: 'live-card-body' }, [
      build('small', { textContent: t(recPaused ? 'rec.paused' : 'live.in-progress') }, []),
      build('span', { className: 'live-card-text', textContent: `${liveTitle()} · ${elapsedText()}` }, []),
    ]),
    open,
  ]);
}
$('live-item').onclick = () => recDir && openMeeting(recDir);
function syncLiveTimer() {
  if (recState === 'recording' && !liveTimer) liveTimer = setInterval(() => (renderLive(), renderRecLabel(), recPaused && renderPause()), 1000);
  if (recState !== 'recording' && liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
  renderLive();
}

function setPaused(on) {
  on = Boolean(on);
  if (on === recPaused) return;
  if (on) pausedSince = Date.now();
  else {
    pausedTotal += Date.now() - pausedSince;
    pausedSince = 0;
  }
  recPaused = on;
  renderPause();
  renderLive();
  renderRecButton();
  refreshList(); // o ponto do item da reunião vira âmbar (e volta a vermelho)
}

/** "Pausar"/"Continuar" ao lado de "Parar" e o selo âmbar "Pausado"; só durante a gravação. */
function renderPause() {
  const btn = $('pause');
  const on = recState === 'recording' && recPaused;
  btn.hidden = recState !== 'recording';
  btn.classList.toggle('paused', on);
  const stopped = on ? pausedText() : '';
  const label = on ? `${t('rec.resume')} · ${stopped}` : t('rec.pause'); // o estado vive no próprio botão: "Continuar · 12:03" (tempo parado)
  const span = btn.querySelector('.pause-label');
  if (span && btn.dataset.paused === String(on)) {
    if (span.textContent !== label) span.textContent = label; // a cada segundo só o texto muda
  } else {
    btn.replaceChildren(window.RiceIcons.icon(on ? 'play' : 'pause'), build('span', { className: 'pause-label', textContent: label }, []));
    btn.dataset.paused = String(on);
  }
  btn.title = on ? `${t('rec.resume.title')} · ${t('rec.paused')} ${stopped}` : t('rec.pause.title'); // na faixa estreita só o ícone: o estado e o tempo ficam no title
  btn.setAttribute('aria-label', btn.title);
}
/** Há quanto tempo está pausado (mm:ss, ou h:mm:ss). */
function pausedText() {
  const total = Math.max(0, Math.floor((Date.now() - pausedSince) / 1000));
  const two = (n) => String(n).padStart(2, '0');
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}` : `${two(Math.floor(total / 60))}:${two(total % 60)}`;
}
$('pause').onclick = () => (recPaused ? window.rice.unpauseRecording() : window.rice.pauseRecording());
window.rice.on('session:pause', ({ dir, paused, line }) => {
  setPaused(paused);
  // o marcador "pausado 14:03–14:07" aparece na transcrição ao vivo assim que se continua
  if (!paused && line && dir === current && transcriptNode) liveScroll.follow(() => addTranscriptLines(line));
});

function renderRecLabel() {
  const resume = current !== null && openIsRecorded && window.RiceResume.shouldResume(openMeta, new Date());
  const away = liveAway();
  const full = away ? `${elapsedText()} · ${t('live.open')}` : recState === 'recording' ? t('rec.stop') : recState === 'finishing' ? t('rec.finishing') : resume ? t('rec.continue') : t('rec.record');
  $('rec-label').textContent = full;
  $('rec-short').textContent = away ? elapsedText() : recState === 'recording' ? t('rec.stop') : recState === 'finishing' ? '…' : t('rec.record'); // versão curta quando a faixa aperta
  $('rec').title = full; // com só o ponto vermelho, o texto completo fica no tooltip e no leitor de tela
  $('rec').setAttribute('aria-label', full);
}

function renderRecButton() {
  const btn = $('rec');
  btn.disabled = recState === 'finishing';
  btn.classList.toggle('recording', recState === 'recording');
  btn.classList.toggle('paused', recState === 'recording' && recPaused);
  renderPause();
  renderRecLabel();
  if (recState === 'idle') {
    lastAsrStatus = null;
    status.asrFailed = false;
    status.asr = '';
    status.capture = '';
    status.download = '';
    renderStatus();
  }
}

$('rec').onclick = async () => {
  if (liveAway()) return openMeeting(recDir); // em outra tela: o botão leva até a reunião em andamento
  if (recState === 'recording') {
    const result = await window.rice.stopRecording();
    if (!result.ok) setWarning(t('common.error', { message: result.message }));
    return;
  }
  // rascunho aberto: usa o rascunho. Reunião já gravada: só retoma o "parei sem querer" (hoje, menos de 60 min); senão, uma nova
  const resume = openIsRecorded && current !== null && window.RiceResume.shouldResume(openMeta, new Date());
  if (openIsDraft || resume) {
    const started = await beginRecording({ title: t('meeting.default-title'), dir: current });
    if (resume && started) window.RiceResume.toast(startNewInstead);
    return;
  }
  await startNewMeeting();
};

async function beginRecording(input) {
  setWarning('');
  const result = await window.rice.startRecording(input);
  if (!result.ok) {
    setWarning(t('common.error', { message: result.message }));
    return false;
  }
  recDir = result.dir;
  markRecorded(result.dir);
  await openMeeting(result.dir);
  return true;
}

/** Reunião nova: o título vem do evento da agenda em andamento (na nota própria da ocorrência); sem evento, o padrão. */
async function startNewMeeting() {
  const events = window.rice.calendarEvents ? await window.rice.calendarEvents().catch(() => []) : [];
  const ev = window.RiceResume.eventNow(events, new Date());
  await beginRecording(ev ? { title: ev.title, dir: await draftFor(ev) } : { title: t('meeting.default-title') });
}

/** "Começar uma nova" do aviso de retomada: encerra a retomada recém-começada e abre outra reunião. */
async function startNewInstead() {
  const stopped = await window.rice.stopRecording();
  if (!stopped.ok) return setWarning(t('common.error', { message: stopped.message }));
  for (let i = 0; i < 150 && recState !== 'idle'; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  if (recState === 'idle') await startNewMeeting();
}

$('retry').onclick = () => window.rice.retryAsr();

window.rice.on('session:state', async (state) => {
  const was = recState;
  recState = state;
  if (state === 'recording' && !recStartedAt) recStartedAt = Date.now();
  if (state === 'idle') {
    window.RiceConsent.hide();
    recStartedAt = 0;
    recPaused = false;
    pausedSince = 0;
    pausedTotal = 0;
  }
  renderRecButton();
  if (typeof renderUpdateBanner === 'function') renderUpdateBanner();
  if (state === 'idle') {
    recDir = null;
  } else {
    const info = await window.rice.sessionState();
    recDir = info.dir;
    setPaused(info.paused === true);
    if (info.dir) markRecorded(info.dir);
    if (state === 'recording' && was === 'idle' && info.dir) window.RiceConsent.offer(info.dir); // por qualquer caminho (botão, Gravar agora, aviso, atalho): só um toast
    if (state === 'finishing' && info.dir) notesPending.add(info.dir);
  }
  syncLiveTimer();
  renderRecLabel();
  syncShotsChip();
  if (state === 'idle') micChip.hide(); // sem gravação, sem chip de microfone
  if (state === 'recording' || was === 'recording') refreshList(); // ponto vermelho na reunião que está gravando
  if (view === 'home' && (was === 'idle') !== (state === 'idle')) showHome(); // "Gravar agora" some/volta na agenda
  if (was !== 'idle' && state === 'idle') {
    refreshList();
    if (current) openMeeting(current);
  }
});

window.rice.on('session:segment', ({ dir, segment }) => {
  if (dir !== current) return;
  if (opening) queuedSegments.push({ dir, segment });
  else appendSegment(segment);
});

window.rice.on('session:partial', ({ dir, partial }) => {
  if (dir !== current || opening) return;
  showPartial(partial);
});

window.rice.on('session:asr-status', (s) => {
  lastAsrStatus = s;
  updateAsrStatus();
  renderStatus();
});

window.rice.on('session:asr-warning', (w) => setWarning(t('status.asr-warning', { source: w.source, message: w.message })));
window.rice.on('session:session-warning', (w) => setWarning(t('status.warning', { message: w.message })));

window.rice.on('session:capture-event', (e) => {
  if (e.event === 'started') {
    const msgs = [];
    const noSys = e.sys === false;
    const noMic = e.mic === false;
    status.capture = noSys || noMic ? () => [noSys && t('status.no-system-audio'), noMic && t('status.no-mic')].filter(Boolean).join(' · ') : '';
  } else if (e.fatal === true) {
    setTransient('capture', t('status.capture-restarted'));
    return;
  }
  renderStatus();
});

/** Avisos persistentes (disco cheio, fonte de áudio perdida...): faixa fina acima do conteúdo, some quando a causa some. */
function renderAlerts(list) {
  const box = $('alerts');
  box.replaceChildren(
    ...list.map((a) => {
      const row = build('div', { className: 'alert ' + a.level }, [build('span', { className: 'alert-text', textContent: a.message }, [])]);
      row.dataset.alert = a.id;
      if (a.action) {
        const act = build('button', { type: 'button', textContent: a.action.label }, []);
        act.onclick = () => window.rice.alertAction(a.id, a.action.kind);
        row.append(act);
      }
      if (a.secondary) {
        const second = build('button', { type: 'button', textContent: a.secondary.label }, []);
        second.onclick = () => window.rice.alertAction(a.id, a.secondary.kind);
        row.append(second);
      }
      if (a.dismissible) {
        const x = build('button', { type: 'button', className: 'alert-x', title: t('alert.dismiss') }, [window.RiceIcons.icon('x')]);
        x.setAttribute('aria-label', t('alert.dismiss'));
        x.onclick = () => window.rice.dismissAlert(a.id);
        row.append(x);
      }
      return row;
    }),
  );
  box.hidden = list.length === 0;
}
window.rice.on('session:alerts', renderAlerts);
if (window.rice.alerts) window.rice.alerts().then(renderAlerts).catch(() => {});

window.rice.on('session:notes-progress', (p) => {
  if (p.phase === 'done') notesProgress.delete(p.dir);
  else notesProgress.set(p.dir, p);
  if (p.dir === current) drawProgress(p.dir);
});

window.rice.on('session:notes', ({ dir, ok, error }) => {
  notesPending.delete(dir);
  if (!ok) setWarning(t('notes.failed', { message: error }));
  refreshList();
  if (dir === current) openMeeting(dir);
});

let asrLoading = false;
window.rice.on('asr:status', ({ state, error }) => {
  asrLoading = state === 'loading';
  status.download = asrLoading ? () => t('status.preparing') : '';
  if (state === 'failed') setWarning(t('status.prepare-failed', { error }));
  renderStatus();
});

window.rice.on('asr:download-progress', ({ receivedBytes, totalBytes }) => {
  const percent = Math.floor((receivedBytes / totalBytes) * 100);
  status.download = receivedBytes >= totalBytes ? (asrLoading ? () => t('status.preparing') : '') : () => t('status.downloading', { percent });
  renderStatus();
});

window.rice.sessionState().then(({ state, dir, paused }) => {
  recState = state;
  recDir = dir;
  setPaused(paused === true);
  renderRecButton();
  syncShotsChip();
});

/** Indicador discreto “via …” perto do chat; relê o provedor ativo quando o guia o troca. */
const aiChip = window.rice.aiStatus ? window.RiceAiChip.create({ rice: window.rice, node: $('ai-via'), onConfigure: () => showGuide('ai'), onSettings: () => showSettings('ai') }) : null;
const activeMessages = () => $(isGlobalScope() ? 'messages-global' : 'messages');
promptChips = window.RicePromptsMenu.create({
  button: $('prompts-btn'),
  saved: [],
  persist: (list) => (window.rice.setSavedPrompts ? window.rice.setSavedPrompts(list) : Promise.resolve(list)),
  defaults: () => (isGlobalScope()
    ? [{ label: t('chat.prompt.week'), prompt: t('chat.prompt.week-q') }, { label: t('chat.prompt.decisions'), prompt: t('chat.prompt.decisions-q') }, { label: t('chat.prompt.owners'), prompt: t('chat.prompt.owners-q') }]
    : [{ label: t('chat.prompt.summary'), prompt: t('chat.prompt.summary-q') }, { label: t('chat.prompt.next'), prompt: t('chat.prompt.next-q') }, { label: t('chat.prompt.risks'), prompt: t('chat.prompt.risks-q') }]),
  canSend: () => (isGlobalScope() ? !globalBusy : current !== null && !$('question').disabled) && $('send').dataset.stop !== '1',
  lastQuestion: () => {
    const asked = activeMessages().querySelectorAll('.msg.user');
    return asked.length > 0 ? asked[asked.length - 1].dataset.question || '' : '';
  },
  onSend: (prompt) => {
    $('question').value = prompt;
    fitQuestion();
    $('ask').requestSubmit();
  },
});
if (window.rice.getSettings) window.rice.getSettings().then((s) => promptChips.set(s.savedPrompts)).catch(() => {});
webSearch = window.RiceWebSearch.create({
  button: $('web-toggle'),
  note: $('web-note'),
  keyOf: () => (isGlobalScope() ? 'global' : current),
  status: () => (window.rice.aiWebStatus ? window.rice.aiWebStatus() : Promise.resolve({ available: false, hint: t('chat.web.unavailable') })),
});
// versão nova: ponto no item Configurações; o aviso completo fica em Configurações › Atualizações
// faixa no topo: só com versão nova, sem "Depois" valendo e fora da gravação (volta quando ela termina)
let lastUpdateStatus = null;
function renderUpdateBanner() {
  const node = $('update-banner');
  if (!node) return;
  window.RiceUpdate.banner(node, lastUpdateStatus, {
    recording: recState !== 'idle',
    windows: window.rice.platform === 'win32',
    onRun: () => window.rice.updateRun(),
    onLater: () => window.rice.updateDismiss().then((status) => applyUpdate(status)).catch(() => {}),
  });
}
const applyUpdate = (status) => window.dispatchEvent(new CustomEvent('rice:update-changed', { detail: status })); // a tela de Configurações ouve o mesmo evento
window.addEventListener('rice:update-changed', (e) => { window.RiceUpdate.applyDot($('settings-link'), e.detail); lastUpdateStatus = e.detail; renderUpdateBanner(); });
if (window.rice.updateStatus) window.rice.updateStatus().then(applyUpdate).catch(() => {});
window.rice.on('update:changed', applyUpdate);
// Windows: o estado da atualização automática (ponto em Configurações e a tela de Atualizações ouvem o mesmo evento)
if (window.rice.platform === 'win32' && window.rice.winUpdateStatus) {
  const applyWinUpdate = (state) => {
    window.dispatchEvent(new CustomEvent('rice:winupdate-changed', { detail: state }));
    window.RiceUpdate.applyDot($('settings-link'), { available: window.RiceWinUpdate.hasNews(state) });
  };
  window.rice.on('winupdate:changed', applyWinUpdate);
  window.rice.winUpdateStatus().then(applyWinUpdate).catch(() => {});
}
// a retenção moveu reuniões para a Lixeira: a lista (e a reunião aberta, se foi ela) se atualizam
window.rice.on('meetings:changed', async () => {
  await refreshList();
  if (current && !lastMeetings.some((m) => m.dir === current)) goHome();
});
// Modo 100% local: selo no rodapé da barra lateral; os controles de rede se explicam sozinhos (cada tela lê o estado do main)
const applyLocalMode = (fullyLocal) => {
  const badge = $('local-badge');
  badge.hidden = !fullyLocal;
  badge.title = t('local.badge.title');
  refreshAiVia();
};
if (window.rice.getSettings) window.rice.getSettings().then((s) => applyLocalMode(s.fullyLocal === true)).catch(() => {});
window.rice.on('privacy:changed', (p) => applyLocalMode(Boolean(p && p.fullyLocal)));
window.addEventListener('rice:local-mode', (e) => applyLocalMode(Boolean(e.detail && e.detail.fullyLocal)));
const refreshAiVia = () => {
  if (webSearch) webSearch.refreshSupport();
  return aiChip && aiChip.refresh();
};
window.addEventListener('rice:ai-changed', refreshAiVia);
refreshAiVia();

window.rice.recoveredCount().then((count) => {
  if (count > 0) setWarning(window.RiceI18n.tn('status.recovered', count));
});

$('new').onclick = async () => {
  const dir = await window.rice.createMeeting('');
  await openMeeting(dir);
};

/** "Nova war room": cria a reunião já como War room e abre na aba Investigação (1 clique). */
async function newWarRoom() {
  const dir = await window.rice.createMeeting('', undefined, undefined, 'warroom'); // o main já grava o tipo (e reaproveita um rascunho vazio)
  rememberMeetingTab(dir, 'war');
  await openMeeting(dir, { tab: 'war' });
}
$('new-war').onclick = newWarRoom;

$('choose').onclick = async () => {
  await window.rice.chooseRoot();
  await refreshRoot();
  await refreshList();
};

applyChat();
renderLangChip();
renderRecLabel();
refreshRoot();
refreshList();
showHome();
window.rice.on('calendar:changed', () => view === 'home' && showHome());
window.rice.on('calendar:disconnected', () => {
  setWarning(t('status.google-expired'));
  if (view === 'home') showHome();
});
window.rice.getSettings().then((settings) => {
  if (!settings.onboardingDone) showGuide();
});

// mantém o status do tutorial ao vivo enquanto ele está aberto
function refreshGuideIfOpen() {
  const box = $('detail').querySelector('.page');
  if (current !== null || !box || !box.querySelector('.step')) return;
  for (const id of ['#token-input', '#google-client-id', '#google-client-secret']) {
    const typing = box.querySelector(id);
    if (typing && (typing.value || document.activeElement === typing)) return;
  }
  window.RiceGuide.render(box, { onClose: closeGuide });
}
window.rice.on('asr:status', refreshGuideIfOpen);

/** Barra de título integrada: recolher a barra lateral (lembrado) e buscar reuniões. */
const SIDEBAR_PREF_KEY = 'rice.sidebarCollapsed';

function applySidebar(collapsed) {
  document.body.classList.toggle('side-collapsed', collapsed);
  $('sidebar-toggle').setAttribute('aria-pressed', String(!collapsed));
  try {
    localStorage.setItem(SIDEBAR_PREF_KEY, collapsed ? '1' : '0');
  } catch {
    // sem armazenamento: só não lembra
  }
}

try {
  if (localStorage.getItem(SIDEBAR_PREF_KEY) === '1') applySidebar(true);
} catch {
  // preferência indisponível
}

/** Janela estreita com o chat aberto: a sidebar está recolhida pelo CSS; o botão a reabre à mão (`side-open`) até o chat fechar. */
const autoCollapsed = () => document.body.classList.contains('chat-open') && !document.body.classList.contains('side-open') && window.matchMedia('(max-width: 1000px)').matches;
$('sidebar-toggle').onclick = () => {
  if (autoCollapsed()) {
    document.body.classList.add('side-open');
    return;
  }
  if (document.body.classList.contains('side-open')) {
    document.body.classList.remove('side-open');
    return;
  }
  applySidebar(!document.body.classList.contains('side-collapsed'));
};

/** Busca da sidebar: filtra em tempo real; × e Esc limpam; ⌘K foca (com a dica ⌘K enquanto está vazio). */
function syncSearchChrome() {
  const has = $('search').value !== '';
  $('search-clear').hidden = !has;
  $('search-hint').hidden = has;
}

if (window.RiceKeys) $('search-hint').textContent = window.RiceKeys.label('K'); // dica ⌘K (Mac) ou Ctrl K (Windows)

function openResult(result) {
  const hit = window.RiceSearch.bestHit(result);
  openMeeting(result.dir, { reveal: { terms: searchWords, field: hit ? hit.field : 'title' } });
}

async function runSearch() {
  clearTimeout(searchTimer);
  searchTimer = null;
  if (!searchQuery || !contentSearch()) return;
  const seq = ++searchSeq;
  let results = [];
  try {
    results = await window.rice.search(searchQuery);
  } catch {
    results = []; // sem resposta do índice: mostra "nada encontrado" em vez de travar a lista
  }
  if (seq !== searchSeq || !searchQuery) return; // chegou uma busca mais nova, ou o campo foi limpo
  searchWords = window.RiceSearch.terms(searchQuery);
  const box = $('results');
  resultsCtl = window.RiceSearch.renderResults(box, results, { input: $('search'), onOpen: openResult });
  resultsCtl.setOpen(current);
  box.setAttribute('aria-label', t('search.results'));
  box.hidden = false;
}

function setSearch(value) {
  $('search').value = value;
  searchQuery = value.trim().toLowerCase();
  syncSearchChrome();
  const content = contentSearch();
  document.body.classList.toggle('searching', Boolean(searchQuery) && content);
  if (!searchQuery) {
    searchSeq++;
    clearTimeout(searchTimer);
    searchTimer = null;
    resultsCtl = null;
    $('results').hidden = true;
    $('search').removeAttribute('aria-activedescendant');
  } else if (content) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
  }
  refreshList();
}

$('search').oninput = () => setSearch($('search').value);
$('search-clear').onclick = () => {
  setSearch('');
  $('search').focus();
};
$('search').onkeydown = (e) => {
  if (e.key === 'Escape' && $('search').value !== '') {
    e.preventDefault();
    setSearch('');
  } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && resultsCtl) {
    e.preventDefault();
    resultsCtl.move(e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === 'Enter' && resultsCtl) {
    e.preventDefault();
    if (searchTimer) runSearch().then(() => resultsCtl && resultsCtl.openActive());
    else resultsCtl.openActive();
  }
};
const onSearchShortcut = (e) => {
  if (!(modKey(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k')) return;
  e.preventDefault();
  if (document.body.classList.contains('side-collapsed')) applySidebar(false);
  $('search').focus();
  $('search').select();
};
if (window.__riceSearchShortcut) document.removeEventListener('keydown', window.__riceSearchShortcut);
window.__riceSearchShortcut = onSearchShortcut;
document.addEventListener('keydown', onSearchShortcut);
syncSearchChrome();

/** Tela de configurações. */
function showSettings(focus) {
  leaveMeeting(null);
  current = null;
  if (webSearch) webSearch.paint();
  warRoom.setDir(null);
  attachments.setDir(null);
  view = 'settings';
  openIsDraft = false;
  openIsRecorded = false;
  renderRecLabel();
  setNav('settings');
  $('messages').replaceChildren(build('p', { className: 'empty', textContent: t('chat.open-first') }, []));
  $('question').disabled = true;
  $('send').disabled = true;
  applyChat();
  const box = build('div', { className: 'page settings-page' }, []);
  $('detail').replaceChildren(box);
  const section = typeof focus === 'string' ? focus : undefined; // 'ai' ou 'calendar' abrem essa seção; sem isso vale a última lembrada
  const rendered = window.RiceSettings.render(box, { onOpenMeeting: (dir) => openMeeting(dir), onOpenMemory: () => showMemory(), onOpenAi: () => showGuide('ai'), section, focus: focus === 'calendar' ? 'calendar' : undefined, confirm: confirmDialog, onChatToolsChange: refreshAiVia });
  refreshList();
  return rendered;
}

$('settings-link').onclick = () => showSettings();
window.rice.on('app:open-settings', () => showSettings());

/** Trocar o idioma do app: aplica no HTML estático e re-renderiza a tela aberta. */
window.rice.on('ui:language', async (language) => {
  // quem tinha o foco (por id ou name) o recebe de volta depois de re-renderizar
  const focused = document.activeElement;
  const focusKey = focused && focused !== document.body ? (focused.name ? `[name="${focused.name}"]${focused.getAttribute('aria-checked') === 'true' ? '[aria-checked="true"]' : ''}` : focused.id ? `#${focused.id}` : null) : null;
  window.RiceI18n.setLanguage(language);
  window.RiceI18n.applyDom();
  // diálogos abertos ficariam no idioma antigo: fecha (o usuário reabre já traduzido)
  for (const overlay of document.querySelectorAll('.overlay')) overlay.remove();
  if (window.RiceActionMenu) window.RiceActionMenu.close(); // menu ⋯ aberto: fecha (seria texto antigo)
  if (window.RiceSpeakerPopover) window.RiceSpeakerPopover.close(false); // popover de falante também
  document.getElementById('toast')?.remove();
  renderLangChip();
  updateAsrStatus();
  renderStatus();
  renderRecLabel();
  refreshList();
  refreshAiVia();
  globalLoading = null;
  if (isGlobalScope()) loadGlobalHistory();
  applyChat();
  if (current) await openMeeting(current);
  else if (view === 'settings') await showSettings();
  else if (view === 'templates') await showTemplates();
  else if (view === 'guide') await showGuide();
  else await showHome();
  const again = focusKey ? document.querySelector(focusKey) : null;
  if (again && again !== document.activeElement && !again.disabled) again.focus();
});

/** ⌘⌫ com uma reunião aberta abre o diálogo de apagar (fora de campos de texto). */
const onDeleteShortcut = (e) => {
  if (!(modKey(e) && e.key === 'Backspace') || current === null) return;
  const target = e.target;
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
  if (document.querySelector('.overlay')) return;
  e.preventDefault();
  const m = lastMeetings.find((x) => x.dir === current);
  openDeleteDialog(current, m ? m.title : ($('page-title') ? $('page-title').textContent : ''));
};
// um único ouvinte, mesmo se este arquivo for carregado de novo (testes)
if (window.__riceDeleteShortcut) document.removeEventListener('keydown', window.__riceDeleteShortcut);
window.__riceDeleteShortcut = onDeleteShortcut;
document.addEventListener('keydown', onDeleteShortcut);

/** Pastas: criar (botão da seção) e soltar uma reunião fora de qualquer pasta tira da pasta. */
$('folder-new').onclick = startNewFolder;
const unfiledZone = $('list');
unfiledZone.ondragover = (e) => {
  if (!hasType(e, MEETING_DRAG) && !hasType(e, FOLDER_DRAG)) return;
  e.preventDefault();
  unfiledZone.classList.add('drop-target');
};
unfiledZone.ondragleave = (e) => {
  if (!unfiledZone.contains(e.relatedTarget)) unfiledZone.classList.remove('drop-target');
};
unfiledZone.ondrop = async (e) => {
  e.preventDefault();
  unfiledZone.classList.remove('drop-target');
  document.body.classList.remove('dragging-meeting');
  const dir = e.dataTransfer.getData(MEETING_DRAG);
  const folderId = e.dataTransfer.getData(FOLDER_DRAG);
  if (dir) await setFolderOf(dir, null);
  else if (folderId) await moveFolderTo(folderId, null); // pasta solta fora de qualquer pasta volta ao nível principal
};

// larguras ajustáveis: barra lateral (200–400, padrão 232) e painel do chat (280–520, padrão 320); salvas em localStorage
window.RiceResize.create({ handle: $('rz-side'), key: 'rice.sidebarWidth', cssVar: '--side-w', min: 200, max: 400, def: 232, edge: 'right', label: t('resize.sidebar') });
window.RiceResize.create({ handle: $('rz-chat'), key: 'rice.chatWidth', cssVar: '--chat-w', min: 280, max: 520, def: 320, edge: 'left', label: t('resize.chat') });
