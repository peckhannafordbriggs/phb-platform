import type { Figure } from "@/lib/home/service";

/**
 * The figure on a Home module card: a large live value and one line of
 * status, or the honest absence of both.
 *
 * Its own file, not a function inside page.tsx, because a Next.js page module
 * may export only the page and its config, and tests/bas-home-tile.test.tsx
 * renders this with the BAS figure at zero and at one to read the text and
 * the mark off the HTML.
 */
export function FigureBlock({ figure }: { figure: Figure }) {
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

  /**
   * The headline is the state, so a value that needs acting on is marked.
   *
   * A maroon mark on the cyan fill, not a maroon fill: the fill is identity
   * (page.tsx) and never changes with state. White on maroon measures well
   * above AA, and the mark is a box around the words rather than a colour on
   * them, because maroon text on the cyan ink would not clear AA. One size
   * down from the calm headline, so "3 points at risk" fits the card at every
   * width without wrapping the mark.
   */
  const alarm = figure.state === "ok" && figure.alarm === true;

  return (
    <div className="mt-5 flex-1">
      <p
        className={
          "font-display font-semibold leading-none tracking-tight " +
          (alarm ? "text-4xl" : "text-5xl")
        }
      >
        {alarm ? (
          <span
            role="status"
            data-testid="home-figure-alarm"
            className="inline-block rounded-md px-3 py-1.5"
            style={{ background: "var(--phb-maroon)", color: "#fff" }}
          >
            {figure.value}
          </span>
        ) : (
          figure.value
        )}
      </p>
      <p className="mt-3 text-sm text-white/85">{figure.status}</p>
    </div>
  );
}
