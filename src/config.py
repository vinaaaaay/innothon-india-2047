"""Shared paths, region maps and constants for the Innothon pipeline."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
PROCESSED = ROOT / "data" / "processed"
OUTPUTS = ROOT / "outputs"
FIGURES = OUTPUTS / "figures"

BASE_YEAR = 2025      # last year of national generation history (OWID)
TARGET_YEAR = 2047
MILESTONES = [2030, 2035, 2040, 2047]

# The six sources named in the problem statement, plus the residual buckets
# that exist in the generation data.
SOURCES = ["Coal", "Gas", "Hydro", "Nuclear", "Solar", "Wind", "Bioenergy", "Other"]

# Canonical state name -> (official-CSV zone, CEA grid region).
# Zone follows the organisers' dataset (six zones, Rajasthan in West).
# Ladakh and DNH&DD are absent from that dataset; they are placed with
# their parent/neighbour (J&K -> North, Gujarat -> West).
STATES = {
    "Andaman and Nicobar": ("South", "Southern"),
    "Andhra Pradesh": ("South", "Southern"),
    "Arunachal Pradesh": ("North-East", "North-Eastern"),
    "Assam": ("North-East", "North-Eastern"),
    "Bihar": ("East", "Eastern"),
    "Chandigarh": ("North", "Northern"),
    "Chhattisgarh": ("Central", "Western"),
    "Dadra and Nagar Haveli and Daman and Diu": ("West", "Western"),
    "Delhi": ("North", "Northern"),
    "Goa": ("West", "Western"),
    "Gujarat": ("West", "Western"),
    "Haryana": ("North", "Northern"),
    "Himachal Pradesh": ("North", "Northern"),
    "Jammu and Kashmir": ("North", "Northern"),
    "Jharkhand": ("East", "Eastern"),
    "Karnataka": ("South", "Southern"),
    "Kerala": ("South", "Southern"),
    "Ladakh": ("North", "Northern"),
    "Lakshadweep": ("South", "Southern"),
    "Madhya Pradesh": ("Central", "Western"),
    "Maharashtra": ("West", "Western"),
    "Manipur": ("North-East", "North-Eastern"),
    "Meghalaya": ("North-East", "North-Eastern"),
    "Mizoram": ("North-East", "North-Eastern"),
    "Nagaland": ("North-East", "North-Eastern"),
    "Odisha": ("East", "Eastern"),
    "Puducherry": ("South", "Southern"),
    "Punjab": ("North", "Northern"),
    "Rajasthan": ("West", "Northern"),
    "Sikkim": ("North-East", "Eastern"),
    "Tamil Nadu": ("South", "Southern"),
    "Telangana": ("South", "Southern"),
    "Tripura": ("North-East", "North-Eastern"),
    "Uttar Pradesh": ("North", "Northern"),
    "Uttarakhand": ("North", "Northern"),
    "West Bengal": ("East", "Eastern"),
}
ZONES = ["North", "West", "South", "East", "Central", "North-East"]

# Spelling differences between sources -> canonical name.
STATE_ALIASES = {
    "Andaman And Nicobar Islands": "Andaman and Nicobar",
    "Jammu And Kashmir": "Jammu and Kashmir",
}


def canonical_state(name: str) -> str:
    name = name.strip()
    return STATE_ALIASES.get(name, name)
