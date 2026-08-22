/** Assembly tree. Virtualized-lite: collapsed by default so 500 parts stay fast. */
import { useMemo, useState } from 'react';
import { useStore } from '@/state/store';
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

  const tree = useMemo(
    () => (sequence ? buildTree(sequence.assembly) : []),
    [sequence],
  );

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
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const renderItem = (item: TreeItem): React.ReactNode => {
    if (matches && !subtreeMatches(item, matches)) return null;
    const isOpen = expanded.has(item.node.id) || !!matches;
    const isSelected = selection.includes(item.node.id);

    return (
      <div key={item.node.id}>
        <div
          className={`tree-row${isSelected ? ' selected' : ''}`}
          style={{ paddingLeft: 6 + item.depth * 14 }}
          onClick={(e) => select([item.node.id], e.ctrlKey || e.metaKey || e.shiftKey)}
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
          <span className="tree-name" title={item.node.name}>
            {item.node.name}
          </span>
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
      <div className="tree-body">{tree.map(renderItem)}</div>
      {selection.length > 0 && (
        <div className="tree-foot">
          {selection.length} selected
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
