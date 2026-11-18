import Link from "next/link";
import { Plus } from "lucide-react";
import type { FpProjectCard } from "@/lib/modules/freeze-protection/catalog";
import type { FpTone } from "@/lib/modules/freeze-protection/types";
import { Button, Card, Empty, Label, Pill } from "../ui/kit";

/**
 * The module's front page: every project as a small card, newest job number first.
 * Nothing is opened until a person picks one (Karthik, 2026-11-12); before
 * that the Equipment tab opened the first project in the picker, which read as
 * "this is the project" to someone who meant another.
 *
 * Each card says where the job stands in words, never colour alone (the
 * module's rule: orange is both its identity and the warning tone). `base` is
 * where a card leads, so the Report tab reuses the catalog to pick a report.
 */

/** Tone -> the words on a card, in the order a person should read them. */
const TONE_WORDS: { tone: FpTone; one: string; many: string }[] = [
  { tone: "bad", one: "needs action", many: "need action" },
  { tone: "warn", one: "to check", many: "to check" },
  { tone: "open", one: "open", many: "open" },
  { tone: "ok", one: "verified", many: "verified" },
  { tone: "closed", one: "closed", many: "closed" },
];

/** Short forms of the Equipment page's signoff words, so a card's pill leaves room for the name. */
function signoff(p: FpProjectCard): { tone: FpTone; label: string } {
  if (p.reviewed) return p.changedAfterReview ? { tone: "warn", label: "Changed since review" } : { tone: "ok", label: "Reviewed" };
  if (p.completed) return { tone: "open", label: "Awaiting review" };
  return { tone: "closed", label: "Not signed" };
}

export function ProjectCatalog({ projects, base }: { projects: FpProjectCard[]; base: string; }) {
  if (projects.length === 0) {
    return (
      <Card className="flex flex-1">
        <Empty>
          <p>No projects yet. A project is one job number and the equipment from its mechanical schedule.</p>
          <Button variant="primary" href="/freeze-protection?new=project">
            <Plus size={16} aria-hidden="true" />
            New project
          </Button>
        </Empty>
      </Card>
    );
  }

  return (
    <section className="flex flex-col gap-2" aria-label="Projects">
      <div className="flex items-baseline justify-between gap-3">
        <Label>Projects · {projects.length}</Label>
      </div>
      {/* Small cards, many to a row: the catalog is for finding a job, the project page is for reading it. */}
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {projects.map((p) => {
          const state = signoff(p);
          const counts = TONE_WORDS.filter((t) => p.tones[t.tone] > 0);
          return (
            <li key={p.id}>
              <Link
                href={`${base}?project=${encodeURIComponent(p.id)}`}
                className="card flex h-full flex-col gap-1.5 px-3.5 py-3 transition-shadow hover:shadow-[var(--shadow-row)]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-mono text-[0.75rem] leading-tight text-[var(--muted)]">{p.jobNumber}</p>
                    <h3 className="line-clamp-2 text-[0.875rem] font-semibold leading-snug">{p.name}</h3>
                  </div>
                  <Pill tone={state.tone}>{state.label}</Pill>
                </div>
                <p className="text-[0.6875rem] text-[var(--muted)]">
                  <span className="font-mono text-[var(--foreground)]">{p.verificationDate}</span>
                  <span aria-hidden="true"> · </span>
                  {p.equipmentCount} unit{p.equipmentCount === 1 ? "" : "s"}
                </p>
                <div className="mt-auto flex flex-wrap gap-1">
                  {counts.length === 0 ? (
                    <span className="text-[0.6875rem] text-[var(--muted)]">No equipment yet</span>
                  ) : (
                    counts.map((t) => (
                      <Pill key={t.tone} tone={t.tone}>
                        {p.tones[t.tone]} {p.tones[t.tone] === 1 ? t.one : t.many}
                      </Pill>
                    ))
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
