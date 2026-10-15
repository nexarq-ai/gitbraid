import type { MissionSummary } from '../shared/types';
import type { MissionSummaryCache } from './coordinator';

export const SUMMARY_DEADLINE_MS = 2_500;
// Durable Object SQLite rows are limited to 2 MB
const CACHE_ENTRY_MAX_CHARS = 1_000_000;

export interface SummarySources {
  live(repositoryId: string): Promise<MissionSummary[]>;
  cached: MissionSummaryCache[];
  save(entries: MissionSummaryCache[]): Promise<void>;
  defer(work: Promise<unknown>): void;
  deadlineMs?: number;
}

export async function collectMissionSummaries(repositoryIds: string[], sources: SummarySources): Promise<{ summaries: MissionSummary[]; stale: number }> {
  const cached = new Map(sources.cached.map(entry => [entry.repositoryId, entry]));
  const deadline = sources.deadlineMs ?? SUMMARY_DEADLINE_MS;
  const changed: MissionSummaryCache[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  let stale = 0;
  const live = repositoryIds.map(id => Promise.resolve().then(() => sources.live(id)).then(summaries => {
    const serialized = JSON.stringify(summaries);
    if (serialized !== JSON.stringify(cached.get(id)?.summaries) && serialized.length <= CACHE_ENTRY_MAX_CHARS) changed.push({ repositoryId: id, summaries, cachedAt: new Date().toISOString() });
    return summaries;
  }));
  sources.defer(Promise.allSettled(live).then(() => changed.length ? sources.save(changed) : undefined));
  try {
    const lists = await Promise.all(repositoryIds.map(async (id, index) => {
      const fallback = cached.get(id);
      if (!fallback) return live[index]!;
      const timeout = new Promise<null>(resolve => { timers.push(setTimeout(() => resolve(null), deadline)); });
      const first = await Promise.race([live[index]!.catch(() => null), timeout]);
      if (first) return first;
      stale++;
      return fallback.summaries;
    }));
    return { summaries: lists.flat(), stale };
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
}
