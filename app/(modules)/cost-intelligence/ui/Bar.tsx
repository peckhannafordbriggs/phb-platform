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