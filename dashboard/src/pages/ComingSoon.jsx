import PageHeader from "../components/PageHeader.jsx";

export default function ComingSoon({ title, feeds }) {
  return (
    <>
      <PageHeader title={title} sub="Not built yet" />
      <div className="soon">
        <div className="lab">Next up</div>
        <p>
          This view is designed but not built yet.
          {feeds.length > 0 && (
            <>
              {" "}
              It will read from {feeds.map((f, i) => (
                <span key={f}>
                  {i > 0 && ", "}
                  <code>{f}</code>
                </span>
              ))}
              .
            </>
          )}
        </p>
      </div>
    </>
  );
}
