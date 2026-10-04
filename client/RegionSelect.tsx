import { ListSubheader, MenuItem, TextField } from "@mui/material";
import type { Location } from "../shared/types.js";
import { regionGroups, sortRegions } from "../shared/regions.js";

export default function RegionSelect({
  regions,
  value,
  onChange,
  loading = false,
  error = "",
  disabled = false,
}: {
  regions: Location[];
  value: string;
  onChange: (value: string) => void;
  loading?: boolean;
  error?: string;
  disabled?: boolean;
}) {
  const options = sortRegions(regions);
  const valid = options.some((region) => region.name === value);
  return (
    <TextField
      select
      label="区域"
      value={valid ? value : ""}
      disabled={disabled || loading || !options.length}
      error={!!error}
      onChange={(event) => onChange(event.target.value)}
      helperText={
        error ||
        (loading
          ? "正在读取实体区域…"
          : options.length
            ? "按大洲分组；具体规格和配额以当前订阅为准"
            : "没有可用的实体区域，请重新加载")
      }
    >
      <MenuItem value="" disabled>
        请选择实体区域
      </MenuItem>
      {regionGroups.flatMap((group) => {
        const members = options.filter(
          (region) => (region.continent ?? "其他区域") === group,
        );
        return members.length
          ? [
              <ListSubheader key={group}>{group}</ListSubheader>,
              ...members.map((region) => (
                <MenuItem key={region.name} value={region.name}>
                  {region.displayName} · {region.name}
                </MenuItem>
              )),
            ]
          : [];
      })}
    </TextField>
  );
}
