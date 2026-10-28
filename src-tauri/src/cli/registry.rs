//! The versions published for a package: crates.io's index, the npm registry and nuget.org.

use crate::net;
use crate::scan::Eco;

fn crate_path(name: &str) -> String {
    let n = name.to_lowercase();
    match n.len() {
        1 => format!("1/{n}"),
        2 => format!("2/{n}"),
        3 => format!("3/{}/{n}", &n[..1]),
        _ => format!("{}/{}/{n}", &n[..2], &n[2..4]),
    }
}

/// Every version that can still be installed (crates.io's yanked ones and npm's deprecated ones
/// left out), oldest first as published.
pub fn versions(eco: Eco, name: &str) -> Result<Vec<String>, String> {
    match eco {
        Eco::Cargo => {
            let t = net::get_text(&format!("https://index.crates.io/{}", crate_path(name)))?;
            Ok(t.lines().filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok()).filter(|j| j["yanked"].as_bool() != Some(true)).filter_map(|j| j["vers"].as_str().map(str::to_string)).collect())
        }
        Eco::Npm => {
            let n = if let Some(rest) = name.strip_prefix('@') { format!("@{}", rest.replacen('/', "%2f", 1)) } else { name.to_string() };
            // The short form of the document: versions without READMEs.
            let j = net::get_json_with(&format!("https://registry.npmjs.org/{n}"), &[("Accept", "application/vnd.npm.install-v1+json")])?;
            Ok(j["versions"].as_object().map(|o| o.iter().filter(|(_, v)| !v["deprecated"].is_string()).map(|(k, _)| k.clone()).collect()).unwrap_or_default())
        }
        Eco::NuGet => {
            let j = net::get_json(&format!("https://api.nuget.org/v3-flatcontainer/{}/index.json", name.to_lowercase()))?;
            Ok(j["versions"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_string)).collect())
        }
    }
}

/// A package's licence as its registry states it (SPDX, like "MIT OR Apache-2.0").
pub fn license(eco: Eco, name: &str, version: &str) -> Option<String> {
    match eco {
        Eco::Cargo => {
            let j = net::get_json(&format!("https://crates.io/api/v1/crates/{name}/{version}")).ok()?;
            j["version"]["license"].as_str().map(str::to_string)
        }
        Eco::Npm => {
            let n = if let Some(rest) = name.strip_prefix('@') { format!("@{}", rest.replacen('/', "%2f", 1)) } else { name.to_string() };
            let j = net::get_json(&format!("https://registry.npmjs.org/{n}/{version}")).ok()?;
            match &j["license"] {
                serde_json::Value::String(s) => Some(s.clone()),
                serde_json::Value::Object(o) => o.get("type").and_then(|t| t.as_str()).map(str::to_string),
                _ => None,
            }
        }
        Eco::NuGet => {
            let t = net::get_text(&format!("https://api.nuget.org/v3-flatcontainer/{0}/{1}/{0}.nuspec", name.to_lowercase(), version.to_lowercase())).ok()?;
            let re = regex::Regex::new(r#"(?s)<license\s+type="expression"\s*>\s*([^<]+?)\s*</license>"#).ok()?;
            if let Some(c) = re.captures(&t) {
                return Some(c[1].to_string());
            }
            let url = regex::Regex::new(r"<licenseUrl>\s*([^<]+?)\s*</licenseUrl>").ok()?.captures(&t).map(|c| c[1].to_string())?;
            Some(if url.contains("licenses.nuget.org/") { url.rsplit('/').next().unwrap_or(&url).to_string() } else { format!("see {url}") })
        }
    }
}
