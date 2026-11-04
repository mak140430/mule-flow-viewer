// A project folder picked by the user (File System Access API, Chromium browsers).
// Works for any repository on any platform, or none.

const SKIP = new Set(['.git', 'target', 'node_modules', '.mule', '.idea', '.vscode', '.settings']);

export async function localFolderAdapter() {
  const dir = await window.showDirectoryPicker({ mode: 'read' });
  const handles = new Map();
  async function walk(handle, prefix) {
    for await (const [name, child] of handle.entries()) {
      if (SKIP.has(name)) continue;
      const path = prefix + name;
      if (child.kind === 'directory') await walk(child, `${path}/`);
      else handles.set(path, child);
    }
  }
  await walk(dir, '');
  return {
    name: dir.name,
    list: async () => [...handles.keys()],
    read: async (path) => (await handles.get(path).getFile()).text(),
  };
}
