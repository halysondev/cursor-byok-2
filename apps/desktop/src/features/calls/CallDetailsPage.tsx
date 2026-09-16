import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type CallDetail } from "../../shared/api";
import { CallDetails } from "./CallDetails";
import { TitledCard } from "../../shared/ui/TitledCard";
import styles from "./CallDetailsPage.module.scss";
import { ScrollableContent } from "../../shared/virtual/ScrollableContent";

export function CallDetailsPage() {
  const { callId = "" } = useParams();
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    void api.call(callId).then((value) => {
      if (!cancelled) setDetail(value);
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
    };
  }, [callId]);

  const content = error
    ? <TitledCard title={"Unable to load call details"}><div style={{ padding: 16 }}>{error}</div></TitledCard>
    : detail
      ? <CallDetails detail={detail} />
      : <TitledCard title={"Call details"}><div style={{ padding: 16 }}>{"Loading call details…"}</div></TitledCard>;

  return <main className={styles.root}>
    <ScrollableContent className={styles.scroller} contentClassName={styles.content}>
      <h1>{detail?.call.display_name ?? "Call details"}</h1>
      {content}
    </ScrollableContent>
  </main>;
}
