import { Bar } from "./Bar";

function Rows({
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