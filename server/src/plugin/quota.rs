//! Aggregates plugin resource quota metrics into a one-line summary appended to
//! the Cursor model hover remark.
use std::collections::HashMap;

use super::descriptor::{LocalizedText, PluginResourceView};

/// Quota line prefix.
const LINE_PREFIX: &str = "Quota: ";

/// Takes the English text of a LocalizedText; falls back to Chinese, then to any
/// available text.
fn en_text(value: &LocalizedText) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Object(map) => ["en-US", "zh-CN"]
            .iter()
            .find_map(|locale| map.get(*locale))
            .or_else(|| map.values().next())
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        _ => String::new(),
    }
}

/// Aggregation bucket for a same-named metric across accounts.
struct MetricBucket {
    label: String,
    unit: String,
    total: f64,
    count: usize,
}

impl MetricBucket {
    /// Average segment: `label 82%`; non-percent units keep the unit and an empty
    /// unit yields only the value.
    fn segment(&self) -> String {
        let average = self.total / self.count as f64;
        let value = if self.unit == "percent" {
            format!("{average:.0}%")
        } else if self.unit.is_empty() {
            format!("{average:.0}")
        } else {
            format!("{average:.0} {}", self.unit)
        };
        if self.label.is_empty() {
            value
        } else {
            format!("{} {value}", self.label)
        }
    }
}

/// Aggregates the display metrics of every account under one resource type into
/// a single line: same-named metrics are averaged across accounts and ordered by
/// first appearance; returns None when there are no metrics (no quota line).
pub fn quota_line(accounts: &[PluginResourceView]) -> Option<String> {
    let mut order = Vec::new();
    let mut buckets = HashMap::<&str, MetricBucket>::new();
    for account in accounts {
        for metric in &account.metrics {
            let bucket = buckets
                .entry(metric.id.as_str())
                .or_insert_with(|| {
                    order.push(metric.id.as_str());
                    MetricBucket {
                        label: en_text(&metric.label),
                        unit: metric.unit.clone(),
                        total: 0.0,
                        count: 0,
                    }
                });
            bucket.total += metric.value;
            bucket.count += 1;
        }
    }
    if order.is_empty() {
        return None;
    }
    let line = order
        .iter()
        .map(|id| buckets[id].segment())
        .collect::<Vec<_>>()
        .join(" · ");
    Some(format!("{LINE_PREFIX}{line}"))
}

#[cfg(test)]
mod tests {
    use super::{
        super::{descriptor::ResourceMetric, state::ResourceState},
        *,
    };

    fn account(metrics: Vec<ResourceMetric>) -> PluginResourceView {
        PluginResourceView {
            id: "resource".into(),
            state: ResourceState::Ready,
            display_name: "account".into(),
            description: serde_json::Value::Null,
            metrics,
            created_at_ms: 0,
        }
    }

    fn metric(id: &str, en_label: &str, value: f64) -> ResourceMetric {
        ResourceMetric {
            id: id.into(),
            label: serde_json::json!({ "zh-CN": id, "en-US": en_label }),
            unit: "percent".into(),
            value,
            reset_at_ms: None,
        }
    }

    #[test]
    fn averages_same_metric_across_accounts() {
        let line = quota_line(&[
            account(vec![metric("weekly", "Weekly quota", 80.0), metric("five-hour", "5-hour window", 90.0)]),
            account(vec![metric("weekly", "Weekly quota", 60.0), metric("five-hour", "5-hour window", 100.0)]),
        ])
        .unwrap();
        assert_eq!(line, "Quota: Weekly quota 70% · 5-hour window 95%");
    }

    #[test]
    fn metrics_present_in_only_one_account_still_show() {
        let line = quota_line(&[
            account(vec![metric("weekly", "Weekly quota", 82.4)]),
            account(Vec::new()),
        ])
        .unwrap();
        assert_eq!(line, "Quota: Weekly quota 82%");
    }

    #[test]
    fn missing_metrics_produce_no_line() {
        assert_eq!(quota_line(&[account(Vec::new())]), None);
        assert_eq!(quota_line(&[]), None);
    }

    #[test]
    fn falls_back_to_plain_string_labels() {
        let mut plain = metric("weekly", "Weekly quota", 50.0);
        plain.label = serde_json::Value::String("Weekly".into());
        let line = quota_line(&[account(vec![plain])]).unwrap();
        assert_eq!(line, "Quota: Weekly 50%");
    }
}
