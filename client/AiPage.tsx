import { useEffect, useState } from "react";
import {
  Alert,
  Autocomplete,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
} from "@mui/material";
import { Bot, ExternalLink, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api } from "./api.js";
import type { Account, Json, Location, Session } from "../shared/types.js";
import type {
  AiDeployment,
  AiModel,
  AiService,
  AiUsage,
} from "../shared/ai.js";

interface Props {
  session: Session;
  notify: (message: string) => void;
  navigate: (page: "tasks") => void;
}
const modelKey = (model: AiModel) =>
  `${model.format}:${model.name}:${model.version}`;
export default function AiPage({ session, notify, navigate }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]),
    [accountId, setAccountId] = useState("");
  const [services, setServices] = useState<AiService[]>([]),
    [serviceId, setServiceId] = useState("");
  const [models, setModels] = useState<AiModel[]>([]),
    [deployments, setDeployments] = useState<AiDeployment[]>([]);
  const [usage, setUsage] = useState<AiUsage[]>([]),
    [usageError, setUsageError] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  const [deployOpen, setDeployOpen] = useState(false),
    [model, setModel] = useState<AiModel | null>(null),
    [sku, setSku] = useState(""),
    [capacity, setCapacity] = useState(1),
    [name, setName] = useState(""),
    [confirmation, setConfirmation] = useState("");
  const [remove, setRemove] = useState<AiDeployment | null>(null),
    [dialogError, setDialogError] = useState(""),
    [saving, setSaving] = useState(false);
  const [serviceOpen, setServiceOpen] = useState(false),
    [groups, setGroups] = useState<Json[]>([]),
    [locations, setLocations] = useState<Location[]>([]);
  const [newGroup, setNewGroup] = useState(""),
    [newLocation, setNewLocation] = useState(""),
    [newKind, setNewKind] = useState("OpenAI");
  const service = services.find((item) => item.id === serviceId);
  const selectedSku = model?.skus.find((item) => item.name === sku);
  const usedQuota = selectedSku?.usageName
    ? usage.find(
        (item) =>
          item.name.toLowerCase() === selectedSku.usageName!.toLowerCase(),
      )
    : undefined;
  const query = service
    ? new URLSearchParams({
        group: service.group,
        name: service.name,
      }).toString()
    : "";
  useEffect(() => {
    let active = true;
    api<Account[]>("/accounts")
      .then((items) => {
        if (active) setAccounts(items);
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setServices([]);
    setServiceId("");
    setModels([]);
    setDeployments([]);
    setUsage([]);
    setError("");
    if (!accountId) return;
    setBusy(true);
    api<AiService[]>(`/accounts/${accountId}/ai/services`)
      .then((items) => {
        if (active) {
          setServices(items);
          setServiceId(items[0]?.id ?? "");
        }
      })
      .catch((error) => {
        if (active) setError(error.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [accountId, refresh]);
  useEffect(() => {
    let active = true;
    setModels([]);
    setDeployments([]);
    setUsage([]);
    setUsageError("");
    setModel(null);
    setError("");
    if (!query) return;
    setBusy(true);
    Promise.all([
      api<AiModel[]>(`/accounts/${accountId}/ai/models?${query}`),
      api<AiDeployment[]>(`/accounts/${accountId}/ai/deployments?${query}`),
      api<AiUsage[]>(`/accounts/${accountId}/ai/usages?${query}`).catch(
        (error) => {
          if (active) setUsageError(error.message);
          return [];
        },
      ),
    ])
      .then(([models, deployments, usages]) => {
        if (active) {
          setModels(models);
          setDeployments(deployments);
          setUsage(usages);
        }
      })
      .catch((error) => {
        if (active) setError(error.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [accountId, query]);
  const resetDialog = () => {
    setName("");
    setConfirmation("");
    setDialogError("");
  };
  async function prepareService() {
    resetDialog();
    setServiceOpen(true);
    setSaving(true);
    setGroups([]);
    setLocations([]);
    setNewGroup("");
    setNewLocation("");
    try {
      const [groups, locations] = await Promise.all([
        api<Json[]>(`/accounts/${accountId}/groups`),
        api<Location[]>(`/accounts/${accountId}/locations`),
      ]);
      setGroups(groups);
      setLocations(locations);
      setNewGroup(groups[0]?.name ?? "");
      setNewLocation(locations[0]?.name ?? "");
    } catch (error) {
      setDialogError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function submit(kind: "service" | "deploy" | "delete") {
    setSaving(true);
    setDialogError("");
    try {
      if (kind === "service")
        await api(`/accounts/${accountId}/ai/services`, "POST", {
          group: newGroup,
          location: newLocation,
          name,
          kind: newKind,
          confirmation,
        });
      else if (kind === "deploy" && service && model)
        await api(`/accounts/${accountId}/ai/deployments`, "POST", {
          group: service.group,
          name: service.name,
          deployment: name,
          model: {
            name: model.name,
            format: model.format,
            version: model.version,
          },
          sku,
          capacity,
          confirmation,
        });
      else if (kind === "delete" && service && remove)
        await api(`/accounts/${accountId}/ai/deployments`, "DELETE", {
          group: service.group,
          name: service.name,
          deployment: remove.name,
          confirmation,
        });
      else return;
      setServiceOpen(false);
      setDeployOpen(false);
      setRemove(null);
      notify("AI 操作已加入后台任务队列");
      navigate("tasks");
    } catch (error) {
      setDialogError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">AZURE AI / MODEL DEPLOYMENTS</div>
          <h1>AI 模型管理</h1>
          <p>
            从 Azure 实时读取模型与容量，管理 OpenAI / AI Services 模型部署。
          </p>
        </div>
        <Button
          variant="contained"
          startIcon={<Plus size={17} />}
          disabled={
            !service || busy || !session.writesEnabled || !models.length
          }
          onClick={() => {
            resetDialog();
            setModel(null);
            setSku("");
            setDeployOpen(true);
          }}
        >
          部署模型
        </Button>
      </div>
      {!session.writesEnabled && (
        <Alert severity="info" sx={{ mb: 2 }}>
          当前为只读模式，可查看模型及部署；创建或删除需启用云端写操作。
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      <Paper className="query-panel">
        <TextField
          label="Azure 账户"
          select
          value={accountId}
          disabled={busy}
          onChange={(event) => setAccountId(event.target.value)}
        >
          <MenuItem value="">请选择账户</MenuItem>
          {accounts.map((item) => (
            <MenuItem key={item.id} value={item.id}>
              {item.label}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          label="AI 服务资源"
          select
          value={serviceId}
          disabled={busy || !services.length}
          onChange={(event) => setServiceId(event.target.value)}
        >
          <MenuItem value="">请选择 AI 服务</MenuItem>
          {services.map((item) => (
            <MenuItem key={item.id} value={item.id}>
              {item.name} · {item.location}
            </MenuItem>
          ))}
        </TextField>
        <Button
          aria-label="刷新 AI 服务"
          disabled={!accountId || busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={17} />
        </Button>
        <Button
          disabled={!accountId || busy || !session.writesEnabled}
          onClick={prepareService}
        >
          创建 AI 服务
        </Button>
      </Paper>
      {busy && <LinearProgress />}
      {service && (
        <Paper className="ai-service-summary">
          <Bot size={26} />
          <div>
            <strong>{service.name}</strong>
            <p>
              {service.kind} · {service.group} · {service.state}
            </p>
            {service.endpoint && <code>{service.endpoint}</code>}
          </div>
          <Button
            component="a"
            href={`https://portal.azure.com/#resource${service.id}`}
            target="_blank"
            rel="noreferrer"
            endIcon={<ExternalLink size={14} />}
          >
            Azure Portal
          </Button>
        </Paper>
      )}
      <Paper className="panel">
        <div className="panel-heading">
          <h2>模型部署</h2>
          <Chip
            size="small"
            label={`${deployments.length} 个部署 · ${models.length} 个模型版本`}
          />
        </div>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                {[
                  "部署名称",
                  "模型 / 版本",
                  "部署类型",
                  "容量单位",
                  "状态",
                  "操作",
                ].map((label) => (
                  <TableCell key={label}>{label}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {deployments.map((item) => (
                <TableRow key={item.name}>
                  <TableCell>{item.name}</TableCell>
                  <TableCell>
                    {item.model.name}
                    <small className="table-sub">
                      {item.model.version} · {item.model.format}
                    </small>
                  </TableCell>
                  <TableCell>{item.sku}</TableCell>
                  <TableCell>{item.capacity}</TableCell>
                  <TableCell>{item.state}</TableCell>
                  <TableCell>
                    <Button
                      color="error"
                      startIcon={<Trash2 size={15} />}
                      disabled={!session.writesEnabled}
                      onClick={() => {
                        resetDialog();
                        setRemove(item);
                      }}
                    >
                      删除部署
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        {!deployments.length && !busy && (
          <div className="empty">
            <Bot size={28} />
            <h3>{service ? "还没有部署模型" : "选择或创建 AI 服务资源"}</h3>
            <p>
              {service
                ? "点击部署模型选择当前服务可用的模型版本。"
                : "服务列表来自当前订阅；没有资源时可以在已有资源组中创建。"}
            </p>
          </div>
        )}
      </Paper>
      {usageError && (
        <Alert severity="warning">配额暂不可读：{usageError}</Alert>
      )}
      <Dialog
        open={deployOpen}
        onClose={() => !saving && setDeployOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>部署 AI 模型</DialogTitle>
        <DialogContent>
          <Stack spacing={3} sx={{ pt: 1 }}>
            {dialogError && <Alert severity="error">{dialogError}</Alert>}
            <Autocomplete
              options={models.filter(
                (model) => model.lifecycle !== "Deprecated",
              )}
              value={model}
              isOptionEqualToValue={(a, b) => modelKey(a) === modelKey(b)}
              getOptionLabel={(model) =>
                `${model.name} · ${model.version} · ${model.format}`
              }
              onChange={(_, model) => {
                setModel(model);
                setSku(model?.skus[0]?.name ?? "");
                setCapacity(model?.skus[0]?.default ?? 1);
              }}
              renderInput={(params) => (
                <TextField {...params} label="模型与版本" />
              )}
            />
            <TextField
              label="部署名称"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <TextField
              label="部署类型"
              select
              value={sku}
              onChange={(event) => {
                setSku(event.target.value);
                setCapacity(
                  model?.skus.find((sku) => sku.name === event.target.value)
                    ?.default ?? 1,
                );
              }}
            >
              <MenuItem value="" disabled>
                选择部署类型
              </MenuItem>
              {model?.skus.map((item) => (
                <MenuItem key={item.name} value={item.name}>
                  {item.name}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="容量单位"
              type="number"
              value={capacity}
              onChange={(event) => setCapacity(Number(event.target.value))}
              helperText={
                selectedSku
                  ? `允许 ${selectedSku.minimum}–${selectedSku.maximum ?? "未提供上限"}，步长 ${selectedSku.step}。不同模型的容量与 TPM 换算不同。`
                  : "请先选择模型和部署类型"
              }
            />
            {usedQuota && (
              <Alert severity="info">
                {usedQuota.label}：已用 {usedQuota.current} / 上限{" "}
                {usedQuota.limit}（{usedQuota.unit}）
              </Alert>
            )}
            {model && model.skus.length === 0 && (
              <Alert severity="warning">
                Azure 未返回该模型的部署类型，暂不可部署。
              </Alert>
            )}
            <Alert severity="warning">
              部署可能占用配额并产生费用，尤其是预置吞吐类型。只创建模型部署，不自动调用模型。
            </Alert>
            <TextField
              label="输入部署名称确认"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={saving} onClick={() => setDeployOpen(false)}>
            取消
          </Button>
          <Button
            variant="contained"
            disabled={
              saving ||
              !model ||
              !sku ||
              !name ||
              confirmation !== name ||
              !session.writesEnabled
            }
            onClick={() => submit("deploy")}
          >
            {saving ? "提交中…" : "确认部署"}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={serviceOpen}
        onClose={() => !saving && setServiceOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>创建 AI 服务资源</DialogTitle>
        <DialogContent>
          <Stack spacing={3} sx={{ pt: 1 }}>
            {dialogError && <Alert severity="error">{dialogError}</Alert>}
            <TextField
              label="资源组"
              select
              value={newGroup}
              onChange={(event) => setNewGroup(event.target.value)}
            >
              <MenuItem value="">请选择已有资源组</MenuItem>
              {groups.map((group) => (
                <MenuItem key={group.name} value={group.name}>
                  {group.name}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="区域"
              select
              value={newLocation}
              onChange={(event) => setNewLocation(event.target.value)}
            >
              <MenuItem value="">请选择区域</MenuItem>
              {locations.map((item) => (
                <MenuItem key={item.name} value={item.name}>
                  {item.displayName} · {item.name}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="服务类型"
              select
              value={newKind}
              onChange={(event) => setNewKind(event.target.value)}
            >
              <MenuItem value="OpenAI">Azure OpenAI</MenuItem>
              <MenuItem value="AIServices">Azure AI Services</MenuItem>
            </TextField>
            <TextField
              label="AI 服务名称"
              value={name}
              onChange={(event) => setName(event.target.value)}
              helperText="名称同时用作自定义子域名，需全局唯一"
            />
            <Alert severity="info">
              使用 S0 层级。区域和服务可用性由 Azure 决定；订阅需已注册
              Microsoft.CognitiveServices。
            </Alert>
            <TextField
              label="输入 AI 服务名称确认"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={saving} onClick={() => setServiceOpen(false)}>
            取消
          </Button>
          <Button
            variant="contained"
            disabled={
              saving ||
              !newGroup ||
              !newLocation ||
              !name ||
              confirmation !== name
            }
            onClick={() => submit("service")}
          >
            创建服务
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={!!remove}
        onClose={() => !saving && setRemove(null)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>删除模型部署</DialogTitle>
        <DialogContent>
          <Stack spacing={3} sx={{ pt: 1 }}>
            {dialogError && <Alert severity="error">{dialogError}</Alert>}
            <Alert severity="warning">
              将删除部署 {remove?.name}，该部署的模型调用将停止。所属 AI
              服务资源保留。
            </Alert>
            <TextField
              label="输入部署名称确认"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={saving} onClick={() => setRemove(null)}>
            取消
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={saving || !remove || confirmation !== remove.name}
            onClick={() => submit("delete")}
          >
            确认删除部署
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
