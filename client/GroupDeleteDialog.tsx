import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  LinearProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import type {
  BatchDeleteResponse,
  GroupDeletionPreview,
} from "../shared/types.js";
import { api } from "./api.js";

export default function GroupDeleteDialog({
  accountId,
  groups,
  enabled,
  onClose,
  onSubmitted,
}: {
  accountId: string;
  groups: string[];
  enabled: boolean;
  onClose: () => void;
  onSubmitted: (response: BatchDeleteResponse) => void;
}) {
  const [previews, setPreviews] = useState<GroupDeletionPreview[] | null>(null);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    setPreviews(null);
    setConfirmation("");
    setAcknowledged(false);
    setError("");
    api<GroupDeletionPreview[]>(
      `/accounts/${accountId}/groups/delete-preview`,
      "POST",
      { groups },
    )
      .then((result) => {
        if (current) setPreviews(result);
      })
      .catch((error) => {
        if (current) setError(error.message);
      });
    return () => {
      current = false;
    };
  }, [accountId, groups, reload]);
  const target = groups.length === 1 ? groups[0] : "DELETE";
  const count =
    previews?.reduce((sum, item) => sum + item.resources.length, 0) ?? 0;
  return (
    <Dialog open onClose={() => !busy && onClose()} fullWidth maxWidth="md">
      <DialogTitle>
        {groups.length === 1 ? "删除资源组" : "批量删除资源组"}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Alert severity="warning">
            将永久删除所选资源组及组内全部资源，包括虚拟机、磁盘、网络及其他服务。
            数据不可恢复，请先确认备份及资源归属。删除期间请勿从其他客户端向目标组新增资源。
          </Alert>
          {!previews && !error && (
            <>
              <LinearProgress />
              <Typography>正在读取完整资源清单…</Typography>
            </>
          )}
          {error && <Alert severity="error">{error}</Alert>}
          {previews && (
            <>
              <Typography>
                共 {previews.length} 个资源组、{count} 个资源，请逐项核对：
              </Typography>
              <TableContainer sx={{ maxHeight: 320 }}>
                <Table size="small" stickyHeader aria-label="待删除资源清单">
                  <TableHead>
                    <TableRow>
                      <TableCell>资源组</TableCell>
                      <TableCell>资源名称</TableCell>
                      <TableCell>资源类型</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {previews.flatMap((preview) =>
                      preview.resources.length
                        ? preview.resources.map((resource) => (
                            <TableRow key={resource.id}>
                              <TableCell>{preview.group}</TableCell>
                              <TableCell sx={{ overflowWrap: "anywhere" }}>
                                {resource.name}
                              </TableCell>
                              <TableCell sx={{ overflowWrap: "anywhere" }}>
                                {resource.type}
                              </TableCell>
                            </TableRow>
                          ))
                        : [
                            <TableRow key={preview.group}>
                              <TableCell>{preview.group}</TableCell>
                              <TableCell colSpan={2}>空资源组</TableCell>
                            </TableRow>,
                          ],
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
              {count > 0 && (
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={acknowledged}
                      onChange={(_, value) => setAcknowledged(value)}
                      disabled={busy}
                    />
                  }
                  label="我已核对上述资源，确认永久删除组内全部资源及数据"
                />
              )}
            </>
          )}
          <TextField
            label={`输入「${target}」确认`}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            disabled={!previews || busy}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button onClick={() => setReload((value) => value + 1)} disabled={busy}>
          重新读取清单
        </Button>
        <Button
          color="error"
          variant="contained"
          disabled={
            !enabled ||
            busy ||
            !previews ||
            !!error ||
            confirmation !== target ||
            (count > 0 && !acknowledged)
          }
          onClick={async () => {
            if (!previews) return;
            setBusy(true);
            try {
              if (groups.length === 1) {
                const result = await api<{ taskId: string }>(
                  `/accounts/${accountId}/groups`,
                  "DELETE",
                  {
                    group: groups[0],
                    fingerprint: previews[0].fingerprint,
                    confirmation,
                  },
                );
                onSubmitted({
                  taskId: result.taskId,
                  results: [{ name: groups[0], status: "queued" }],
                });
              } else {
                onSubmitted(
                  await api<BatchDeleteResponse>(
                    `/accounts/${accountId}/groups/delete-batch`,
                    "POST",
                    {
                      groups: previews.map(({ group, fingerprint }) => ({
                        group,
                        fingerprint,
                      })),
                      confirmation,
                    },
                  ),
                );
              }
            } catch (error) {
              setError((error as Error).message);
              setConfirmation("");
              setAcknowledged(false);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "提交中…" : "确认执行"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
