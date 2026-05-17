interface Props {
  title: string;
  body?: string;
  cta?: React.ReactNode;
}

export function EmptyState({ title, body, cta }: Props) {
  return (
    <div className="empty">
      <div className="empty__title">{title}</div>
      {body && <p className="empty__lede">{body}</p>}
      {cta && <div className="empty__cta">{cta}</div>}
    </div>
  );
}
