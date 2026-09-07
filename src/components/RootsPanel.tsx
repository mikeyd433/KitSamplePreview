import { useState } from "react";

import { useLibrary } from "../stores/library";
import type { FolderNode } from "../ipc/commands";

/**
 * Library roots and the folder tree (SPEC §6, §7.1).
 *
 * Roots are added by typing or pasting a path. A native folder picker would be
 * better and needs `tauri-plugin-dialog`, which is not on SPEC §3's dependency
 * list — and §15 asks that additions to it be a decision rather than a detail,
 * so it is flagged rather than pulled in.
 */
export function RootsPanel(): React.JSX.Element {
  const roots = useLibrary((s) => s.roots);
  const folders = useLibrary((s) => s.folders);
  const rootId = useLibrary((s) => s.rootId);
  const subtree = useLibrary((s) => s.subtree);
  const addRoot = useLibrary((s) => s.addRoot);
  const removeRoot = useLibrary((s) => s.removeRoot);
  const setRoot = useLibrary((s) => s.setRoot);
  const setSubtree = useLibrary((s) => s.setSubtree);

  const [draft, setDraft] = useState("");

  const submit = (): void => {
    const path = draft.trim();
    if (path === "") return;
    setDraft("");
    void addRoot(path);
  };

  return (
    <aside className="roots-panel">
      <h2>ROOTS</h2>

      <div className="add-root">
        <input
          type="text"
          spellCheck={false}
          value={draft}
          placeholder={String.raw`C:\Samples`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <button onClick={submit} disabled={draft.trim() === ""}>
          add
        </button>
      </div>

      <ul className="root-list">
        <li>
          <button
            className={`root${rootId === null ? " active" : ""}`}
            onClick={() => setRoot(null)}
          >
            All roots
          </button>
        </li>
        {roots.map((root) => (
          <li key={root.id}>
            <button
              className={`root${rootId === root.id ? " active" : ""}`}
              onClick={() => setRoot(root.id)}
              title={root.path}
            >
              {root.label}
              <span className="count">{root.sampleCount}</span>
            </button>
            <button
              className="remove"
              title={`Remove ${root.label} from the library. Files on disk are untouched.`}
              onClick={() => void removeRoot(root.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      {folders.length > 0 && (
        <>
          <h2>FOLDERS</h2>
          <FolderTree
            folders={folders}
            selected={subtree}
            onSelect={(dir) => setSubtree(dir === subtree ? null : dir)}
          />
        </>
      )}
    </aside>
  );
}

interface TreeNode {
  name: string;
  relDir: string;
  ownCount: number;
  children: TreeNode[];
}

/**
 * Nests the flat folder list Rust returns.
 *
 * Flat over the wire, nested here: the tree is small even for a large library,
 * and keeping the recursion on one side of the boundary means only one of them
 * has to be right.
 */
function buildTree(folders: readonly FolderNode[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const byPath = new Map<string, TreeNode>();

  const ensure = (relDir: string): TreeNode | null => {
    if (relDir === "") return null;
    const existing = byPath.get(relDir);
    if (existing !== undefined) return existing;

    const cut = relDir.lastIndexOf("\\");
    const name = cut === -1 ? relDir : relDir.slice(cut + 1);
    const node: TreeNode = { name, relDir, ownCount: 0, children: [] };
    byPath.set(relDir, node);

    const parent = cut === -1 ? null : ensure(relDir.slice(0, cut));
    if (parent === null) roots.push(node);
    else parent.children.push(node);
    return node;
  };

  for (const folder of folders) {
    const node = ensure(folder.relDir);
    if (node !== null) node.ownCount += folder.sampleCount;
  }
  return roots;
}

function FolderTree({
  folders,
  selected,
  onSelect,
}: {
  folders: readonly FolderNode[];
  selected: string | null;
  onSelect: (relDir: string) => void;
}): React.JSX.Element {
  const tree = buildTree(folders);
  return (
    <ul className="tree">
      {tree.map((node) => (
        <TreeBranch key={node.relDir} node={node} depth={0} selected={selected} onSelect={onSelect} />
      ))}
    </ul>
  );
}

function TreeBranch({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (relDir: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = node.children.length > 0;

  return (
    <li>
      <div className="tree-row" style={{ paddingLeft: depth * 12 }}>
        <button
          className="twisty"
          onClick={() => setOpen((v) => !v)}
          disabled={!hasChildren}
          aria-label={open ? "Collapse" : "Expand"}
        >
          {hasChildren ? (open ? "▾" : "▸") : "·"}
        </button>
        <button
          className={`tree-name${selected === node.relDir ? " active" : ""}`}
          onClick={() => onSelect(node.relDir)}
          title={node.relDir}
        >
          {node.name}
          {node.ownCount > 0 && <span className="count">{node.ownCount}</span>}
        </button>
      </div>
      {open && hasChildren && (
        <ul>
          {node.children.map((child) => (
            <TreeBranch
              key={child.relDir}
              node={child}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
