"""Generation-only guard.

The problem statement bans installed capacity and energy consumption as a
basis for forecasting or comparison. Every loader in the pipeline goes
through this module, so a banned field cannot enter a processed table
without raising.
"""
import re

import pandas as pd

BANNED_COLUMN_PATTERNS = [
    r"install", r"capacity", r"\bmw\b", r"\bgw\b", r"plf", r"load factor",
    r"consumption", r"demand", r"sales", r"\bmet\b", r"requirement \(mu\)",
]
BANNED_UNITS = {"MW", "GW", "kW"}
ALLOWED_ENERGY_UNITS = {"GWh", "TWh", "MU", "kWh"}

_audit_log: list[dict] = []


def is_banned_column(col: str) -> bool:
    c = str(col).lower()
    return any(re.search(p, c) for p in BANNED_COLUMN_PATTERNS)


def assert_clean(df: pd.DataFrame, name: str) -> pd.DataFrame:
    """Raise if a table carries a banned column or unit; otherwise log and pass through."""
    bad = [c for c in df.columns if is_banned_column(c)]
    if bad:
        raise ValueError(f"[compliance] {name}: banned columns {bad}")
    if "unit" in df.columns:
        units = set(df["unit"].dropna().unique())
        if units & BANNED_UNITS:
            raise ValueError(f"[compliance] {name}: banned units {units & BANNED_UNITS}")
    _audit_log.append({"table": name, "rows": len(df), "columns": ", ".join(map(str, df.columns))})
    return df


def record_source(name: str, source: str, kept: str, dropped: str) -> None:
    """Record what was read from a raw source and what was deliberately discarded."""
    _audit_log.append({"table": name, "source": source, "kept": kept, "dropped": dropped})


def audit_frame() -> pd.DataFrame:
    return pd.DataFrame(_audit_log)
