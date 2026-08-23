/**
 * Assembly tree.
 *
 * Two-way selection sync with the viewport:
 *  - clicking a row selects that part or the whole sub-assembly
 *  - picking in 3D auto-expands ancestors, scrolls the row into view,
 *    and highlights every selected member
 *
 * Collapsed by default so 500 parts stay fast (AGENTS.md §7).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/state/store';
import { ancestorsOf, revealTargetFor, selectFromTreeRow } from '@/domain/authoring';
import type { Assembly, PartNode } from '@/domain/schema';

interface TreeItem {
  node: PartNode;
  depth: number;
  children: TreeItem[];
}

function buildTree(assembly: Assembly): TreeItem[] {
  const byParent = new Map<string | null, PartNode[]>();
  for (const node of Object.values(assembly.parts)) {
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }

  const make = (node: PartNode, depth: number): TreeItem => ({
    node,
    depth,
    children: (byParent.get(node.id) ?? []).map((c) => make(c, depth + 1)),
  });

  return (byParent.get(null) ?? []).map((n) => make(n, 0));
}

export function AssemblyTree() {
  const sequence = useStore((s) => s.sequence);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);

  const tree = useMemo(
    () => (sequence ? buildTree(sequence.assembly) : []),
    [sequence],
  );

  const selectionSet = useMemo(() => new Set(selection), [selection]);

  /**
   * Reveal the current selection: expand its ancestors and scroll to it.
   * Keyed on the selection contents so a viewport pick drives the tree,
   * but re-clicking the same row does not fight the user's scrolling.
   */
  const selectionKey = selection.join(',');
  useEffect(() => {
    if (!sequence || !selection.length) return;

    const target = revealTargetFor(sequence.assembly, selection);
    if (!target) return;

    const chain = ancestorsOf(sequence.assembly, target);
    if (chain.length) {
      setExpanded((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const id of chain) {
          if (!next.has(id)) {
            next.add(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }

    // Wait a tick so newly-expanded rows exist before scrolling.
    const raf = requestAnimationFrame(() => {
      const el = bodyRef.current?.querySelector<HTMLElement>(
        `[data-part-id="${CSS.escape(target)}"]`,
      );
      el?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [selectionKey, sequence, selection]);

  const matches = useMemo(() => {
    if (!filter.trim() || !sequence) return null;
    const q = filter.toLowerCase();
    return new Set(
      Object.values(sequence.assembly.parts)
        .filter((p) => p.name.toLowerCase().includes(q))
        .map((p) => p.id),
    );
  }, [filter, sequence]);

  if (!sequence) return <div className="panel-empty">No model loaded</div>;

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderItem = (item: TreeItem): React.ReactNode => {
    if (matches && !subtreeMatches(item, matches)) return null;

    const isOpen = expanded.has(item.node.id) || !!matches;
    const isSelected = selectionSet.has(item.node.id);
    // A group row highlights when everything under it is selected, so
    // picking a sub-assembly in 3D visibly lights up its branch.
    const isBranchSelected =
      item.node.isGroup && item.children.length > 0 && branchSelected(item, selectionSet);

    return (
      <div key={item.node.id}>
        <div
          data-part-id={item.node.id}
          className={`tree-row${isSelected || isBranchSelected ? ' selected' : ''}`}
          style={{ paddingLeft: 6 + item.depth * 14 }}
          onClick={(e) => {
            const ids = selectFromTreeRow(sequence.assembly, item.node.id);
            select(ids, e.ctrlKey || e.metaKey || e.shiftKey);
          }}
          title={item.node.isGroup ? `${item.node.name} (sub-assembly)` : item.node.name}
        >
          {item.children.length > 0 ? (
            <span
              className="twisty"
              onClick={(e) => {
                e.stopPropagation();
                toggle(item.node.id);
              }}
            >
              {isOpen ? '▾' : '▸'}
            </span>
          ) : (
            <span className="twisty spacer" />
          )}
          <span className={item.node.isGroup ? 'node-group' : 'node-part'}>
            {item.node.isGroup ? '▣' : '◆'}
          </span>
          <span className="tree-name">{item.node.name}</span>
        </div>
        {isOpen && item.children.map(renderItem)}
      </div>
    );
  };

  const partCount = Object.values(sequence.assembly.parts).filter((p) => !p.isGroup).length;

  return (
    <div className="tree">
      <div className="panel-head">
        <span>Assembly</span>
        <span className="muted">{partCount} parts</span>
      </div>
      <input
        className="filter"
        placeholder="Filter parts…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="tree-body" ref={bodyRef}>{tree.map(renderItem)}</div>
      {selection.length > 0 && (
        <div className="tree-foot">
          <span>{selection.length} selected</span>
          <button onClick={() => select([])}>clear</button>
        </div>
      )}
    </div>
  );
}

function subtreeMatches(item: TreeItem, matches: Set<string>): boolean {
  if (matches.has(item.node.id)) return true;
  return item.children.some((c) => subtreeMatches(c, matches));
}

/** True when every mesh under this node is selected. */
function branchSelected(item: TreeItem, selection: Set<string>): boolean {
  if (!item.node.isGroup) return selection.has(item.node.id);
  if (!item.children.length) return false;
  return item.children.every((c) => branchSelected(c, selection));
}
