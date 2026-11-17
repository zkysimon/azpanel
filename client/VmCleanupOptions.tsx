import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  FormControlLabel,
  LinearProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import type { VirtualMachine, VmDeletionPreview } from "../shared/types.js";
import { api } from "./api.js";

export interface VmCleanupChoice {
  loading: boolean;
  cleanup: boolean;
  confirmed: boolean;
  preview?: VmDeletionPreview;
  error?: string;
}

export default function VmCleanupOptions({
  vm,
  value,
  onChange,
}: {
  vm: VirtualMachine;
  value: VmCleanupChoice;
  onChange: (value: VmCleanupChoice) => void;
}) {
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    onChange({ loading: true, cleanup: false, confirmed: false });
    api<VmDeletionPreview>(`/machines/${vm.id}/delete-preview`)
      .then((preview) => {
        if (active)
          onChange({
            loading: false,
            cleanup: preview.cleanupAvailable,
            confirmed: false,
            preview,
          });
      })
      .catch((error) => {
        if (active)
          onChange({
            loading: false,
            cleanup: false,
            confirmed: false,
            error: error.message,
          });
      });
    return () => {
      active = false;
    };
  }, [vm.id, reload, onChange]);
  return (
    <Stack spacing={2}>
      {value.loading && (
        <>
          <LinearProgress />
          <Typography>正在检查虚拟机附属资源…</Typography>
        </>
      )}
      {value.error && (
        <Alert severity="warning">
          无法核对附属资源：{value.error}。目前只能仅删除 VM；磁盘、公网 IP
          等可能保留并继续计费。
        </Alert>
      )}
      {value.preview && !value.preview.cleanupAvailable && (
        <Alert severity="warning">{value.preview.reason}</Alert>
      )}
      {value.preview?.cleanupAvailable && (
        <>
          <FormControlLabel
            control={
              <Checkbox
                checked={value.cleanup}
                onChange={(_, cleanup) =>
                  onChange({ ...value, cleanup, confirmed: false })
                }
              />
            }
            label="同时清理附属资源及独立资源组（磁盘、网卡、公网 IP、虚拟网络、安全组）"
          />
          {value.cleanup && (
            <>
              <Alert severity="error">
                将删除资源组 {value.preview.group!.group}{" "}
                及下列全部资源，磁盘数据不可恢复。请确认备份；删除期间请勿从其他客户端新增或修改资源。
              </Alert>
              <TableContainer sx={{ maxHeight: 240 }}>
                <Table size="small" aria-label="虚拟机附属资源清单">
                  <TableHead>
                    <TableRow>
                      <TableCell>资源名称</TableCell>
                      <TableCell>资源类型</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {value.preview.group!.resources.map((resource) => (
                      <TableRow key={resource.id}>
                        <TableCell sx={{ overflowWrap: "anywhere" }}>
                          {resource.name}
                        </TableCell>
                        <TableCell sx={{ overflowWrap: "anywhere" }}>
                          {resource.type}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={value.confirmed}
                    onChange={(_, confirmed) =>
                      onChange({ ...value, confirmed })
                    }
                  />
                }
                label="我已核对清单，确认永久删除虚拟机及上述全部附属资源和数据"
              />
            </>
          )}
          {!value.cleanup && (
            <Alert severity="warning">
              仅删除 VM；保留项由 Azure deleteOption 决定，未清理的磁盘和公网
              IPv4 可能继续计费。
            </Alert>
          )}
        </>
      )}
      <Button
        disabled={value.loading}
        onClick={() => setReload((value) => value + 1)}
      >
        重新检查附属资源
      </Button>
    </Stack>
  );
}
