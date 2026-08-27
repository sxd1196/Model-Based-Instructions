/**
 * Bake-off variants: named configurations of the planning pipeline that can
 * be raced against each other on the benchmark set (user: "experiment like
 * an ML project — wide variety of algorithms, standard metrics").
 *
 * Each variant is a pure flag-set consumed by planSequence via setPlannerConfig
 * (module-level config keeps the planner's public API unchanged for the app).
 */
export interface PlannerConfig {
  /** Candidate escape vectors: canonical axes only (baseline) or axes +
   * contact-normal/push-out vectors (v4 'mating-vector' mode). */
  directions: 'axes' | 'mating-vectors';
  /** Contact normal method: 'gradient' (clearance gradient, current),
   * 'triangles' (mating-triangle voting — reconstructs the mate plane from
   * coplanar near-contact triangles), or 'none' (no contact steering). */
  normals: 'gradient' | 'triangles' | 'none';
  /** Use hierarchy (BOM-tree units largest-first) or flat meshes (v1-style). */
  hierarchy: boolean;
  label: string;
  description: string;
}

export const VARIANTS: Record<string, PlannerConfig> = {
  baseline: {
    label: 'Baseline (6-axis, no contact steering)',
    description:
      'The dumbest defensible planner: six canonical directions tried in fixed gravity-first order, hierarchical units, honest collision checks. No contact intelligence. This is the control group.',
    directions: 'axes',
    normals: 'none',
    hierarchy: true,
  },
  gradient: {
    label: 'Clearance gradient (current)',
    description:
      'Contact normals measured by probing which direction opens the part-to-part gap fastest (±1.5mm probes). Escape candidates = mating normals + push-out + axes. The algorithm currently shipping on the branch.',
    directions: 'mating-vectors',
    normals: 'gradient',
    hierarchy: true,
  },
  triangles: {
    label: 'Mating-triangle reconstruction',
    description:
      "Reconstructs mating surfaces from the tessellation itself: collects the moving part's triangles that sit within 0.8mm of the partner, clusters them by facing direction, and uses the dominant cluster's area-weighted normal as the mate normal. The 'compare the triangles that are mating' approach.",
    directions: 'mating-vectors',
    normals: 'triangles',
    hierarchy: true,
  },
  flat: {
    label: 'Flat (no hierarchy) + gradient',
    description:
      'Ablation: the gradient contact model but v1-style flat part list (no BOM-tree units). Isolates how much of the quality comes from the hierarchy vs the contact model.',
    directions: 'mating-vectors',
    normals: 'gradient',
    hierarchy: false,
  },
};

let active: PlannerConfig = VARIANTS.gradient;

export function setPlannerConfig(cfg: PlannerConfig): void {
  active = cfg;
}

export function plannerConfig(): PlannerConfig {
  return active;
}
