export function LoadingScreen({ label = "Loading" }: { label?: string }) {
  return (
    <div className="fullscreen-loading">
      <div className="stack-tight" style={{ alignItems: "center" }}>
        <span className="ring" aria-hidden />
        <span>{label}</span>
      </div>
    </div>
  );
}
