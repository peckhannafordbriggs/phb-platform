/** Placeholder for a view that has not been built: its name and what will go in it. */
export function Skeleton({
  title,
  items,
  children,
}: {
  title: string;
  items: string[];
  children?: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold">{title}</h2>
      <ul className="mt-2 list-disc pl-5 text-sm">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {children !== undefined && <div className="mt-4 flex gap-4 text-sm">{children}</div>}
    </section>
  );
}
