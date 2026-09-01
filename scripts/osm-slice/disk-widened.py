"""Disk for the widened kill gate. Every input is a measured figure; extrapolation is labelled.

Sizes are `pg_total_relation_size` after VACUUM ANALYZE, with the duplicate GiST index that
osm2pgsql and the load script were each creating dropped first — the first gate's figures carried
both copies and so overstated every slice.
"""

GIB = 1024**3
CONUS_KM2 = 8_080_000

# Measured 2026-08-30 on postgis/postgis:17-3.5, after dropping the duplicated geometry indexes.
IDAHO = {
    "trail_way": 136_593_408,
    "trail_relation": 1_925_120,
    "relation_node_member": 24_576,
    "network_way": 222_085_120,
    "admin_area": 1_662_976,
    "feature_node": 2_506_752,
    "feature_way": 3_104_768,
}
NORCAL = {
    "trail_way": 333_479_936,
    "trail_relation": 12_197_888,
    "relation_node_member": 24_576,
    "network_way": 613_302_272,
    "admin_area": 4_046_848,
    "feature_node": 23_306_240,
    "feature_way": 22_724_608,
}

# ST_Area(geography) over the Geofabrik .poly, re-measured this run.
AREA_KM2 = {"Idaho": 217_780, "NorCal": 420_222}  # NorCal includes ocean, so its density understates land

TRAIL = ("trail_way", "trail_relation", "relation_node_member")
CONTEXT = ("admin_area", "feature_node", "feature_way")
NETWORK = ("network_way",)

PROD_DISK = 64 * GIB
CEILING = 0.40  # of production disk, doubled for the staging-schema swap


def part(slice_bytes, keys):
    return sum(slice_bytes[k] for k in keys)


def report(name, slice_bytes):
    km2 = AREA_KM2[name]
    trail, context, network = part(slice_bytes, TRAIL), part(slice_bytes, CONTEXT), part(slice_bytes, NETWORK)
    print(f"\n== {name} ({km2:,} km2) ==")
    for label, value in [
        ("TRAIL (ways, relations, node members)", trail),
        ("CONTEXT (admin, feature nodes, feature ways)", context),
        ("NETWORK (z12 foot-legal)", network),
        ("ALL THREE", trail + context + network),
        ("TRAIL + CONTEXT only", trail + context),
    ]:
        density = value / km2
        conus_doubled = density * CONUS_KM2 * 2
        pct = conus_doubled / PROD_DISK * 100
        verdict = "fits" if pct <= CEILING * 100 else "OVER"
        print(
            f"  {label:<44} {value/1e6:>8.1f} MB at region"
            f" | {density:>8,.0f} B/km2"
            f" | CONUS x2 {conus_doubled/1e9:>6.2f} GB = {pct:>5.1f}% of 64GiB [{verdict}]"
        )


print("Region extent is what the product serves: coverage.ts is viewport-driven and on-demand,")
print("and no covered extent is defined anywhere in the repository.")
print(f"Ceiling: {CEILING:.0%} of {PROD_DISK/GIB:.0f} GiB, applied to the doubled (staging-swap) figure.")
print("CONUS columns are EXTRAPOLATION from a measured regional density, not a measurement.")

report("Idaho", IDAHO)
report("NorCal", NORCAL)

print("\n== the slice the first gate never sized ==")
for name, s in [("Idaho", IDAHO), ("NorCal", NORCAL)]:
    context = part(s, CONTEXT)
    total = sum(s.values())
    print(
        f"  {name:<8} context = {context/1e6:>6.1f} MB"
        f" = {context/total*100:>4.1f}% of the whole slice"
        f" | admin {s['admin_area']/1e6:.1f} + nodes {s['feature_node']/1e6:.1f} + ways {s['feature_way']/1e6:.1f}"
    )
