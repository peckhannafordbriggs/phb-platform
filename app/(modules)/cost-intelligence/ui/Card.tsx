/** The platform's `.card` surface. Padding is a prop, not a class, so it can't lose to the default. */
export function Card({
  className = "",
  padding = "p-5",
  children,
}: {
  className?: string;
  padding?: string;
  children: React.ReactNode;
}) {
  return <div className={`card ${padding} ${className}`}>{children}</div>;
}
