import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  FormControlLabel,
  LinearProgress,
  MenuItem,
  Stack,
  TextField,
} from "@mui/material";
import type { IpReplacementOption } from "../shared/types.js";
import { api } from "./api.js";

export interface IpReplacementChoice {
  option?: IpReplacementOption;
  deleteOld: boolean;
  loading: boolean;
}
export default function IpReplacementOptions({
  vmId,
  value,
  onChange,
}: {
  vmId: string;
  value: IpReplacementChoice;
  onChange: (choice: IpReplacementChoice) => void;
}) {
  const [options, setOptions] = useState<IpReplacementOption[]>([]);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    setOptions([]);
    onChange({ loading: true, deleteOld: true });
    api<IpReplacementOption[]>(`/machines/${vmId}/ip-options`)
      .then((options) => {
        if (!active) return;
        setOptions(options);
        onChange({
          loading: false,
          deleteOld: true,
          option: options.find((item) => !item.unavailableReason),
        });
      })
      .catch((error) => {
        if (!active) return;
        setError(error.message);
        onChange({ loading: false, deleteOld: true });
      });
    return () => {
      active = false;
    };
  }, [vmId, reload, onChange]);
  return (
    <Stack spacing={2}>
      {value.loading && <LinearProgress />}
      {error && <Alert severity="error">{error}</Alert>}
      {!value.loading && !error && !options.length && (
        <Alert severity="info">
          没有可更换的直接绑定公网 IP。此操作不创建新的地址版本或为仅 IPv6
          机器增加 IPv4。
        </Alert>
      )}
      {!!options.length && (
        <TextField
          select
          label="要更换的公网 IP"
          value={value.option?.id ?? ""}
          disabled={value.loading}
          onChange={(event) =>
            onChange({
              ...value,
              option: options.find((item) => item.id === event.target.value),
            })
          }
        >
          {options.map((item) => (
            <MenuItem
              key={item.id}
              value={item.id}
              disabled={!!item.unavailableReason}
            >
              {item.version} · {item.address} · {item.nicName}/
              {item.configuration}
            </MenuItem>
          ))}
        </TextField>
      )}
      {options
        .filter((item) => item.unavailableReason)
        .map((item) => (
          <Alert key={item.id} severity="warning">
            {item.version} · {item.address}：{item.unavailableReason}
          </Alert>
        ))}
      <FormControlLabel
        control={
          <Checkbox
            checked={value.deleteOld}
            disabled={value.loading}
            onChange={(_, deleteOld) => onChange({ ...value, deleteOld })}
          />
        }
        label="新 IP 切换成功后删除旧公网 IP（释放旧地址，不可保证找回）"
      />
      {!value.deleteOld && (
        <Alert severity="warning">
          旧公网 IPv4 即使未绑定也可能继续计费，请在资源浏览器自行清理。
        </Alert>
      )}
      <Alert severity="info">
        新地址由 Azure 分配，不能指定 IP 或保证网段；新旧 IPv4
        短暂并存可能计费。域名解析、客户端白名单及连接地址需要自行更新。Azure
        DNS 标签、IP 前缀等特殊配置暂不支持。
      </Alert>
      <Button
        disabled={value.loading}
        onClick={() => setReload((value) => value + 1)}
      >
        重新读取公网 IP
      </Button>
    </Stack>
  );
}
