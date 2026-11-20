/** One replaceable preview alongside tabs the user has chosen to keep open. */
export class EditorTabs {
  paths: string[] = [];
  preview: string | undefined;

  restore(paths: string[], preview?: string): void {
    this.paths = paths;
    this.preview = preview && paths.includes(preview) ? preview : undefined;
  }

  open(path: string, keepOpen = false): void {
    if (!this.paths.includes(path)) {
      const index = this.preview ? this.paths.indexOf(this.preview) : -1;
      if (!keepOpen && index >= 0) this.paths.splice(index, 1, path);
      else this.paths.push(path);
      if (!keepOpen) this.preview = path;
    }
    if (keepOpen) this.keep(path);
  }

  keep(path: string): void {
    if (this.preview === path) this.preview = undefined;
  }

  remove(paths: readonly string[]): void {
    this.paths = this.paths.filter(path => !paths.includes(path));
    if (this.preview && paths.includes(this.preview)) this.preview = undefined;
  }

  rename(oldPath: string, nextPath: string): void {
    const move = (path: string) => path === oldPath || path.startsWith(`${oldPath}/`) ? nextPath + path.slice(oldPath.length) : path;
    this.paths = this.paths.map(move);
    if (this.preview) this.preview = move(this.preview);
  }
}
