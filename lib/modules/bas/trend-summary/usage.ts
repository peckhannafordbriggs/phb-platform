import { prisma } from "@/lib/db";

/**
 * Trend summaries on the Usage page (2026-11-20): every call in the window,
 * written or withheld, with its tokens and dollars - metered onto
 * bas_trend_summaries by the service, one row per call. Module-wide, like
 * the summaries themselves: they are shared by everyone who opens the point.
 * Its own module so the Usage page does not import the summary service.
 */
export interface TrendSummaryUsage {
  written: number;
  withheld: number;
  tokens: number;
  spend: number;
}

export async function trendSummaryUsage(since: Date, until: Date): Promise<TrendSummaryUsage> {
  const where = { createdAt: { gte: since, lte: until } };
  const [all, written] = await Promise.all([
    prisma.basTrendSummary.aggregate({
      where,
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, costUsd: true },
    }),
    prisma.basTrendSummary.count({ where: { ...where, summary: { not: null } } }),
  ]);
  return {
    written,
    withheld: all._count._all - written,
    tokens: (all._sum.inputTokens ?? 0) + (all._sum.outputTokens ?? 0),
    spend: Number(all._sum.costUsd ?? 0),
  };
}
