import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAuthenticated } from "@/lib/authz";
import { moduleAccent } from "@/lib/module-accent";
import {
  getHomeData,
  type Figure,
  type HomeModuleCard,
  type LastVisit,
} from "@/lib/home/service";

export const dynamic = "force-dynamic";

/**
 * Home: a personal launcher.
 *
 * Everything on this page is real data about the person signed in. There is no
 * activity feed, no invented metric and nothing here to fill a column - if a
 * figure cannot be obtained it says so and keeps its way in, because the way in
 * is what the card is for.
 *
 * THE ARRIVAL MOMENT
 * The greeting is centred rather than set as a top-left heading, with the cards
 * below it. That is the one composition decision on this page: it is the first
 * thing anyone sees after signing in, and a centred greeting with air around it
 * reads as arriving somewhere instead of as the top of a document.
 *
 * COLOUR
 * The four-light ground and the near-white card edges are the BAS dashboard's,
 * shared rather than reimplemented (app/globals.css). The module cards are
 * FILLED in each module's identity colour - red for Change Orders, cyan for
 * Building Automation, from lib/module-accent.ts - which is safe here because
 * neither is a semantic tone: this palette says ok/warn/bad in teal, orange and
 * maroon, and `--danger` is deliberately maroon rather than red. The rule that
 * keeps it safe is that NO state colour appears on these cards; state is said in
 * words. See .card--filled in app/globals.css for the measured contrast.
 */
export default async function HomePage() {
  const access = await requireAuthenticated();
  // AppShell has already enforced both of these; this is the type narrowing and
  // a second closed door, not a new policy.
  if (!access.ok) redirect("/signin");

  const { greeting, modules, since } = await getHomeData(access.viewer);

  /*
   * Exactly the margins BAS uses, including relying on .dashboard-ground's own
   * min-height rather than adding a viewport height here - two different height
   * rules for the same ground is how they drift apart.
   */
  return (
    <div className="dashboard-ground home-ground -mx-8 -my-8 px-8 py-8">
      <div className="mx-auto max-w-5xl">
        <Greeting {...greeting} />

        {modules.length === 0 ? (
          <NoAccess />
        ) : (
          <>
            <div className="mt-14 grid gap-5 sm:grid-cols-2">
              {modules.map((module, index) => (
                <ModuleCard key={module.key} card={module} index={index} />
              ))}
            </div>
            <Since items={since} />
          </>
        )}
      </div>
    </div>
  );
}

function Greeting({
  firstName,
  positionName,
  departmentName,
  lastVisit,
}: {
  firstName: string;
  positionName: string | null;
  departmentName: string | null;
  lastVisit: LastVisit;
}) {
  /**
   * Position and department are joined only when both exist, so somebody who
   * has filled in one does not get a dangling separator. Both are self-reported
   * on the profile and either can legitimately be blank.
   */
  const role = [positionName, departmentName].filter(Boolean).join(" · ");

  return (
    <header className="pt-10 text-center sm:pt-16">
      <h1 className="font-display text-4xl font-semibold tracking-tight sm:text-5xl">
        {greetingFor(new Date())}, {firstName}
      </h1>

      {role.length > 0 && (
        <p className="mt-4 text-sm text-[var(--muted)]">{role}</p>
      )}

      {/*
        Three states, and the third renders NOTHING on purpose.

        "unknown" is somebody who has been here before while their
        previous_login_at predates the column - true of every existing employee
        the day it shipped. Telling them "this is your first time here" would be
        a false claim about their own history, and there is no honest timestamp
        to offer instead, so the line is simply absent. It fills itself in on
        their next sign-in.
      */}
      {lastVisit.state !== "unknown" && (
        <p className="mt-1.5 text-sm text-[var(--muted)]">
          {lastVisit.state === "first"
            ? "This is your first time here"
            : `Last signed in ${formatSignIn(lastVisit.at)}`}
        </p>
      )}
    </header>
  );
}

/**
 * The module card: a large live number, one line of status, and a way in.
 *
 * The whole card is the link. A card whose only target is a small text link at
 * the bottom makes the hero element on the page a decoration with a button on
 * it.
 */
function ModuleCard({ card, index }: { card: HomeModuleCard; index: number }) {
  const accent = moduleAccent(card.key, index);

  /**
   * The fill is the INK value, not the bright one. White on the sampled brights
   * fails AA for the status line - red 4.22, cyan 3.47 - where the ink siblings
   * measure 4.81 and 4.82.
   *
   * The bright hue is deliberately NOT passed down. The card's shade darkens
   * rather than lightens, so the ink is the lightest pixel on the card and
   * those two measurements are a floor; handing the component a bright value
   * would only make it possible to reintroduce the failure. See .card--filled
   * in app/globals.css.
   */
  const style = { "--card-fill": accent.ink } as React.CSSProperties;

  return (
    <Link
      href={card.href}
      style={style}
      className="card--filled group block overflow-hidden p-7 transition-transform hover:-translate-y-0.5 focus-visible:-translate-y-0.5"
    >
      {/* Above the ::after highlight, which is inset over the whole card. */}
      <div className="relative z-10 flex h-full flex-col">
        <p className="eyebrow text-white/75">{card.displayName}</p>

        <FigureBlock figure={card.figure} />

        <p className="mt-6 text-sm font-medium text-white/90">
          {card.action}
          <span aria-hidden="true" className="ml-1.5 inline-block transition-transform group-hover:translate-x-0.5">
            &rarr;
          </span>
        </p>
      </div>
    </Link>
  );
}

function FigureBlock({ figure }: { figure: Figure }) {
  if (figure.state === "unavailable") {
    return (
      <div className="mt-5 flex-1">
        {/*
          No number at all, rather than a zero. "0 drafts" and "we could not ask
          Exchange" are opposite claims and must never render the same - this is
          the same rule the BAS tiles follow for a null reading.
        */}
        <p className="font-display text-2xl font-semibold leading-tight text-white/85">
          {figure.status}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-5 flex-1">
      <p className="font-display text-5xl font-semibold leading-none tracking-tight">
        {figure.value}
      </p>
      <p className="mt-3 text-sm text-white/85">{figure.status}</p>
    </div>
  );
}

function Since({ items }: { items: SinceItemList }) {
  // Null means there is no previous sign-in to measure from. An empty list means
  // there was one and nothing happened. Neither is worth a heading over nothing.
  if (items === null || items.length === 0) return null;

  return (
    <section className="mt-12">
      <h2 className="eyebrow text-[var(--muted)]">Since you last signed in</h2>

      <ul className="card mt-3 divide-y divide-[var(--border)] overflow-hidden">
        {items.map((item) => (
          <li key={item.key}>
            {item.href === null ? (
              <p className="px-5 py-3.5 text-sm">{item.text}</p>
            ) : (
              <Link
                href={item.href}
                className="block px-5 py-3.5 text-sm hover:bg-[var(--neutral-100)]"
              >
                {item.text}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

type SinceItemList = Awaited<ReturnType<typeof getHomeData>>["since"];

/**
 * No grants: say exactly that and stop.
 *
 * No welcome copy, no tour, no empty cards where modules would go. Someone in
 * this state cannot do anything on the platform yet, and filler would only
 * obscure the one sentence that tells them why.
 */
function NoAccess() {
  return (
    <p className="mx-auto mt-10 max-w-md text-center text-sm text-[var(--muted)]">
      You have not been granted access to any systems yet. An administrator
      grants access; signing in does not.
    </p>
  );
}

/** Local to the reader's machine, which is the only clock they can check it against. */
function greetingFor(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * A previous sign-in, in the reader's own timezone.
 *
 * Relative for the last day because "yesterday at 4:58 pm" is what someone
 * actually remembers; absolute beyond that, because "17 days ago" is a number
 * you have to do arithmetic on to place.
 */
function formatSignIn(at: Date): string {
  const time = at.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  if (at >= startOfToday) return `today at ${time}`;
  if (at >= startOfYesterday) return `yesterday at ${time}`;

  return `on ${at.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  })} at ${time}`;
}
