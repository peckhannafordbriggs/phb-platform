/** Skeleton primitives: grey shapes that hold a view's layout until it has content. */

export function Bar({
  w = "100%",
  h = 10,
  className = "",
}: {
  w?: number | string;
  h?: number;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={"shrink-0 rounded-full bg-[var(--neutral-200)] " + className}
      style={{ width: w, height: h }}
    />
  );
}

export function Pill({ w = 88 }: { w?: number }) {
  return <Bar w={w} h={22} />;
}

export function Button({ w = 104, filled = false }: { w?: number | string; filled?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={
        "h-9 shrink-0 rounded-[var(--radius-control)] " +
        (filled ? "bg-[var(--module-accent-ink)] opacity-40" : "border border-[var(--border)] bg-white")
      }
      style={{ width: w }}
    />
  );
}

export function Card({
  className = "",
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={"card p-5 " + className}>{children}</div>;
}

export function Label({ children }: { children: React.ReactNode }) {
  return <p className="eyebrow mb-3 text-[var(--muted)]">{children}</p>;
}

/** A column of repeated rows, each rendered by `row(i)`. */
export function Rows({
  n,
  gap = "gap-3",
  row,
}: {
  n: number;
  gap?: string;
  row: (i: number) => React.ReactNode;
}) {
  return (
    <div className={"flex flex-col " + gap}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i}>{row(i)}</div>
      ))}
    </div>
  );
}

/** A table: a header line, then `rows` lines of `cols` bars at the given widths. */
export function Table({ rows, cols }: { rows: number; cols: (number | string)[] }) {
  const grid = { gridTemplateColumns: cols.map(() => "1fr").join(" ") };
  return (
    <div>
      <div className="grid gap-4 border-b border-[var(--border)] pb-3" style={grid}>
        {cols.map((w, i) => (
          <Bar key={i} w={typeof w === "number" ? w * 0.6 : "40%"} h={8} />
        ))}
      </div>
      <Rows
        n={rows}
        gap="gap-0"
        row={() => (
          <div className="grid items-center gap-4 border-b border-[var(--divider-soft)] py-3.5" style={grid}>
            {cols.map((w, i) => (
              <Bar key={i} w={w} />
            ))}
          </div>
        )}
      />
    </div>
  );
}
