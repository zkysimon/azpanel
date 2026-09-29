import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Alert,
  Avatar,
  Button,
  Chip,
  CircularProgress,
  CssBaseline,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  IconButton,
  InputAdornment,
  LinearProgress,
  MenuItem,
  Paper,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  ThemeProvider,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Check,
  CheckCheck,
  ChevronRight,
  Cloud,
  CloudCog,
  Copy,
  Database,
  ExternalLink,
  Folder,
  Gauge,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Moon,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sun,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import type {
  Account,
  Audit,
  Json,
  Location,
  MetricPoint,
  Overview,
  Session,
  Sku,
  Task,
  User,
  VirtualMachine,
} from "../shared/types.js";
import type { CreateVm } from "../shared/validation.js";
import {
  fallbackImages,
  looksLikeWindows,
  type ImageOption,
} from "../shared/images.js";
import { api, setCsrf } from "./api.js";
import { makeTheme } from "./theme.js";
import "./styles.css";
const MetricsChart = lazy(() => import("./MetricsChart.js"));

type Page =
  | "overview"
  | "accounts"
  | "machines"
  | "create"
  | "resources"
  | "quota"
  | "tasks"
  | "settings";
const date = (value: number | null) =>
  value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "尚未同步";
const stateLabel: Record<string, string> = {
  running: "运行中",
  deallocated: "已释放",
  stopped: "已停止",
  starting: "启动中",
  stopping: "停止中",
  unknown: "未知",
  Enabled: "可用",
  Disabled: "已停用",
  Warned: "受限",
  queued: "排队中",
  runningTask: "执行中",
  succeeded: "已完成",
  failed: "失败",
  interrupted: "已中断",
};
function Status({ value }: { value: string }) {
  return (
    <Chip
      size="small"
      className={`status status-${value}`}
      label={
        <span className="status-label">
          <span />
          {stateLabel[value] ?? value}
        </span>
      }
    />
  );
}
function Empty({
  title = "这里还没有内容",
  description = "接入账户并同步后，你的资源会显示在这里。",
  action,
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-symbol">
        <Cloud size={30} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
function Heading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
function Panel({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Paper className="panel">
      <div className="panel-heading">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </Paper>
  );
}
function useLoad<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await loader());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload };
}
function LoadError({ error }: { error: string }) {
  return error ? (
    <Alert severity="error" sx={{ mb: 2 }}>
      {error}
    </Alert>
  ) : null;
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const session = await api<Session>("/login", "POST", { email, password });
      setCsrf(session.csrf);
      onLogin(session);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-layout">
      <section className="login-art">
        <div className="brand">
          <div className="brand-mark">
            <Cloud />
          </div>
          azpanel<span>2.0</span>
        </div>
        <div className="login-story">
          <div className="eyebrow">A LITTLE LESS COMPLEXITY.</div>
          <h1>
            你的云端，
            <br />
            井然有序。
          </h1>
          <p>
            从一个工作空间，连接你的基础设施。
            <br />
            更清晰的状态，更从容的管理。
          </p>
          <div className="orbit">
            <div className="orbit-ring" />
            <div className="orbit-core">
              <Cloud size={62} strokeWidth={1.3} />
            </div>
            <div className="orbit-node node-one">
              <Server />
            </div>
            <div className="orbit-node node-two">
              <ShieldCheck />
            </div>
            <div className="orbit-node node-three">
              <Database />
            </div>
          </div>
        </div>
        <div className="login-foot">OPEN SOURCE · BUILT FOR YOUR CLOUD</div>
      </section>
      <section className="login-form">
        <form onSubmit={submit}>
          <div className="login-icon">
            <KeyRound size={28} />
          </div>
          <Typography variant="h4">欢迎回来</Typography>
          <p className="muted">登录你的云资源工作空间。</p>
          <Stack spacing={3} sx={{ mt: 4 }}>
            <LoadError error={error} />
            <TextField
              label="邮箱"
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <TextField
              label="密码"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button
              type="submit"
              size="large"
              variant="contained"
              disabled={busy}
              endIcon={
                busy ? <CircularProgress size={18} /> : <ArrowRight size={18} />
              }
            >
              进入工作空间
            </Button>
          </Stack>
          <p className="login-help">
            首次使用？管理员账户在服务启动时通过环境配置创建。
          </p>
        </form>
      </section>
    </div>
  );
}

interface PageProps {
  navigate: (page: Page) => void;
  notify: (message: string) => void;
  session: Session;
  revision: number;
}
function OverviewPage({ navigate, revision }: PageProps) {
  const { data, error, loading } = useLoad(
    () => api<Overview>("/overview"),
    [revision],
  );
  const stats = [
    {
      label: "已接入账户",
      value: data?.accounts,
      icon: Cloud,
      foot: `${data?.enabled ?? 0} 个可用订阅`,
      page: "accounts",
    },
    {
      label: "虚拟机",
      value: data?.machines,
      icon: Server,
      foot: "全部计算资源",
      page: "machines",
    },
    {
      label: "正在运行",
      value: data?.running,
      icon: Zap,
      foot: "最近同步的运行状态",
      page: "machines",
    },
    {
      label: "覆盖区域",
      value: data?.regions,
      icon: Activity,
      foot: "资源部署区域",
      page: "resources",
    },
  ];
  return (
    <>
      <Heading
        eyebrow="WORKSPACE OVERVIEW"
        title="一切，尽在掌握。"
        description="你的云资源概览。今天，也让管理更简单一点。"
        action={
          <Button
            variant="contained"
            startIcon={<Plus size={18} />}
            onClick={() => navigate("create")}
          >
            创建虚拟机
          </Button>
        }
      />
      <LoadError error={error} />
      {loading && <LinearProgress />}
      <div className="stats-grid">
        {stats.map((stat, index) => (
          <Paper
            className="stat-card"
            key={stat.label}
            onClick={() => navigate(stat.page as Page)}
          >
            <div className="stat-top">
              <span>{stat.label}</span>
              <div className={`stat-icon tone-${index}`}>
                <stat.icon size={21} />
              </div>
            </div>
            <strong>{stat.value ?? "—"}</strong>
            <div className="stat-foot">
              {index === 0 && <span className="small-dot" />}
              {stat.foot}
              <ArrowUpRight size={16} />
            </div>
          </Paper>
        ))}
      </div>
      <section className="welcome-banner">
        <div>
          <div className="eyebrow">LESS FRICTION. MORE POSSIBILITY.</div>
          <h2>连接你的下一个可能。</h2>
          <p>
            接入 Azure 账户，在一个地方管理订阅、计算和网络。
            <br />
            所有云操作可追踪，资源状态一目了然。
          </p>
          <Button
            variant="contained"
            onClick={() => navigate("accounts")}
            endIcon={<ArrowRight size={17} />}
          >
            管理云账户
          </Button>
          <Button onClick={() => navigate("quota")}>查看资源配额</Button>
        </div>
        <div className="banner-illustration" aria-hidden="true">
          <div className="illustration-glow" />
          <div className="illustration-card card-back">
            <Cloud size={32} />
            <span>AZURE CLOUD</span>
          </div>
          <div className="illustration-card card-front">
            <div>
              <Server size={28} />
              <span className="small-dot" />
            </div>
            <span>Connected to possibility</span>
            <div className="illustration-bars">
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
          </div>
          <div className="illustration-check">
            <Check size={24} />
          </div>
        </div>
      </section>
      <div className="overview-bottom">
        <Panel
          title="最近的虚拟机"
          action={
            <Button
              size="small"
              onClick={() => navigate("machines")}
              endIcon={<ChevronRight size={16} />}
            >
              查看全部
            </Button>
          }
        >
          {data?.recentMachines.length ? (
            data.recentMachines.map((vm) => (
              <div className="resource-line" key={vm.id}>
                <div className="resource-icon">
                  <Server size={20} />
                </div>
                <div className="resource-line-main">
                  <b>{vm.name}</b>
                  <span>
                    {vm.location} · {vm.size.replace("Standard_", "")}
                  </span>
                </div>
                <Status value={vm.powerState} />
              </div>
            ))
          ) : (
            <Empty
              title="你的第一台虚拟机，从这里开始"
              action={
                <Button onClick={() => navigate("accounts")}>
                  接入账户 <ArrowRight size={16} />
                </Button>
              }
            />
          )}
        </Panel>
        <Panel
          title="最近活动"
          action={
            <IconButton aria-label="查看任务" onClick={() => navigate("tasks")}>
              <MoreHorizontal size={20} />
            </IconButton>
          }
        >
          {data?.tasks.length ? (
            data.tasks.map((task) => (
              <div className="activity-line" key={task.id}>
                <div className={`activity-dot ${task.status}`} />
                <div>
                  <b>{task.kind}</b>
                  <p>{task.target}</p>
                  <small>{date(task.createdAt)}</small>
                </div>
                <Status value={task.status} />
              </div>
            ))
          ) : (
            <Empty
              title="一切准备就绪"
              description="同步和管理任务会记录在这里。"
            />
          )}
        </Panel>
      </div>
    </>
  );
}

function AccountsPage({ notify, revision }: PageProps) {
  const { data, error, loading, reload } = useLoad(
    () => api<Account[]>("/accounts"),
    [revision],
  );
  const [open, setOpen] = useState(false),
    [json, setJson] = useState(""),
    [label, setLabel] = useState(""),
    [subscriptionId, setSubscriptionId] = useState(""),
    [formError, setFormError] = useState(""),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState("");
  const [edit, setEdit] = useState<Account | null>(null),
    [secret, setSecret] = useState(""),
    [remove, setRemove] = useState<Account | null>(null),
    [confirmation, setConfirmation] = useState("");
  async function save() {
    setBusy(true);
    setFormError("");
    try {
      if (edit)
        await api(`/accounts/${edit.id}`, "PUT", {
          label,
          password: secret || undefined,
        });
      else {
        let credentials: Json;
        try {
          credentials = JSON.parse(json);
        } catch {
          throw new Error("JSON 格式不正确，请粘贴完整的服务主体 JSON");
        }
        await api("/accounts", "POST", {
          label: label || credentials.displayName || "Azure 账户",
          credentials,
          subscriptionId:
            subscriptionId ||
            credentials.subscriptionId ||
            credentials.subscription_id ||
            undefined,
        });
      }
      setOpen(false);
      setJson("");
      setSecret("");
      notify(edit ? "账户已更新" : "账户已接入。点击同步读取资源。");
      await reload();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function sync(account: Account) {
    try {
      await api(`/accounts/${account.id}/sync`, "POST");
      notify("同步任务已加入队列，可在任务中心查看进度");
    } catch (e) {
      notify((e as Error).message);
    }
  }
  return (
    <>
      <Heading
        eyebrow="CONNECTED ACCOUNTS"
        title="云账户"
        description="连接订阅，掌握你的云资源。凭据经加密保存于本地。"
        action={
          <Button
            variant="contained"
            startIcon={<Plus size={18} />}
            onClick={() => {
              setEdit(null);
              setLabel("");
              setFormError("");
              setOpen(true);
            }}
          >
            接入账户
          </Button>
        }
      />
      <LoadError error={error} />
      <div className="filter-bar">
        <TextField
          placeholder="搜索账户名称或订阅"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <Search size={18} />
                </InputAdornment>
              ),
            },
          }}
        />
        <Chip label={`${data?.length ?? 0} 个账户`} variant="outlined" />
        <Tooltip title="刷新本地列表">
          <IconButton onClick={reload}>
            <RefreshCw size={18} />
          </IconButton>
        </Tooltip>
      </div>
      {loading && <LinearProgress />}
      <div className="account-grid">
        {data
          ?.filter((account) =>
            `${account.label} ${account.subscriptionName}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .map((account) => (
            <Paper className="account-card" key={account.id}>
              <div className="account-card-top">
                <div className="azure-symbol">
                  <Cloud size={28} />
                </div>
                <Status value={account.state} />
              </div>
              <h2>{account.label}</h2>
              <p className="muted">{account.subscriptionName}</p>
              <div className="account-id">
                {account.subscriptionId}
                <Tooltip title="复制订阅 ID">
                  <IconButton
                    size="small"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(account.subscriptionId)
                        .then(() => notify("已复制订阅 ID"))
                        .catch(() => notify("复制失败"));
                    }}
                  >
                    <Copy size={14} />
                  </IconButton>
                </Tooltip>
              </div>
              <Divider sx={{ my: 2 }} />
              <div className="account-meta">
                <span>最近同步</span>
                <span>{date(account.lastSync)}</span>
              </div>
              {account.error && (
                <Alert severity="warning" sx={{ mt: 2 }}>
                  {account.error}
                </Alert>
              )}
              <div className="account-actions">
                <Button
                  variant="tonal"
                  startIcon={<RefreshCw size={16} />}
                  onClick={() => sync(account)}
                >
                  同步资源
                </Button>
                <Button
                  onClick={() => {
                    setEdit(account);
                    setLabel(account.label);
                    setSecret("");
                    setFormError("");
                    setOpen(true);
                  }}
                >
                  编辑
                </Button>
                <Tooltip title="移除本地账户">
                  <IconButton
                    size="small"
                    onClick={() => {
                      setRemove(account);
                      setConfirmation("");
                    }}
                  >
                    <Trash2 size={17} />
                  </IconButton>
                </Tooltip>
              </div>
            </Paper>
          ))}
      </div>
      {data?.length === 0 && (
        <Empty
          title="连接你的第一个 Azure 账户"
          description="准备好 Azure CLI 的服务主体 JSON，即可开始。"
          action={
            <Button variant="outlined" onClick={() => setOpen(true)}>
              接入账户
            </Button>
          }
        />
      )}
      <Dialog
        open={open}
        onClose={() => !busy && setOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{edit ? "编辑账户" : "接入 Azure 账户"}</DialogTitle>
        <DialogContent>
          <Stack spacing={3} sx={{ pt: 1 }}>
            <LoadError error={formError} />
            <TextField
              label="账户名称"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              helperText="留空使用 JSON 中的 displayName"
            />
            {edit ? (
              <TextField
                type="password"
                label="新客户端密钥"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                helperText="留空保留原密钥；更新前会验证新密钥"
              />
            ) : (
              <>
                <TextField
                  label="服务主体 JSON"
                  multiline
                  minRows={7}
                  value={json}
                  onChange={(e) => setJson(e.target.value)}
                  placeholder={
                    '{\n  "appId": "…",\n  "password": "…",\n  "tenant": "…"\n}'
                  }
                />
                <TextField
                  label="订阅 ID（选填）"
                  value={subscriptionId}
                  onChange={(e) => setSubscriptionId(e.target.value)}
                  helperText="默认选择第一个 Enabled 订阅"
                />
                <Alert severity="info">
                  接入只验证身份并读取订阅，不自动创建资源。应用需要订阅范围的
                  Reader（只读）或 Contributor（管理）角色。
                </Alert>
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)} disabled={busy}>
            取消
          </Button>
          <Button variant="contained" disabled={busy} onClick={save}>
            {busy ? "验证中…" : "保存账户"}
          </Button>
        </DialogActions>
      </Dialog>
      <ConfirmDialog
        open={!!remove}
        title="移除本地账户"
        description="移除面板中的账户及缓存。Azure 云端资源仍然保留。"
        target={remove?.label ?? ""}
        value={confirmation}
        onChange={setConfirmation}
        onClose={() => setRemove(null)}
        onConfirm={async () => {
          try {
            await api(`/accounts/${remove!.id}`, "DELETE", { confirmation });
            setRemove(null);
            await reload();
            notify("已移除本地账户");
          } catch (e) {
            notify((e as Error).message);
          }
        }}
      />
    </>
  );
}

function ConfirmDialog({
  open,
  title,
  description,
  target,
  value,
  onChange,
  onClose,
  onConfirm,
  children,
  disabled,
}: {
  open: boolean;
  title: string;
  description: string;
  target: string;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  children?: React.ReactNode;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={3} sx={{ pt: 1 }}>
          <Alert severity="warning">{description}</Alert>
          {children}
          <TextField
            label={`输入「${target}」确认`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            autoComplete="off"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button
          color="error"
          variant="contained"
          disabled={disabled || busy || value !== target}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
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

function MachinesPage({ notify, navigate, session, revision }: PageProps) {
  const { data, error, loading, reload } = useLoad(
    () => api<VirtualMachine[]>("/machines"),
    [revision],
  );
  const [search, setSearch] = useState(""),
    [selected, setSelected] = useState<VirtualMachine | null>(null),
    [action, setAction] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [size, setSize] = useState(""),
    [disk, setDisk] = useState(64),
    [details, setDetails] = useState<VirtualMachine | null>(null);
  const actionNames: Record<string, string> = {
    start: "启动虚拟机",
    powerOff: "关机（保留计算分配）",
    deallocate: "停止并释放计算资源",
    restart: "重启虚拟机",
    resize: "调整规格",
    disk: "扩容系统盘",
    delete: "删除虚拟机",
  };
  const descriptions: Record<string, string> = {
    start: "启动后将按 Azure 价格继续计费。",
    powerOff: "关机仍保留计算资源分配，可能继续产生计算费用。",
    deallocate: "虚拟机将中断服务并释放计算资源。磁盘和公网 IP 仍计费。",
    restart: "重启会暂时中断此虚拟机的服务。",
    resize: "变更规格可能重启虚拟机，并改变计费。",
    disk: "请先停止并释放虚拟机。系统盘只能扩容，扩容后需在操作系统内扩展分区。",
    delete:
      "删除此虚拟机。磁盘与网卡是否保留取决于现有 Azure deleteOption；请先确认备份。",
  };
  return (
    <>
      <Heading
        eyebrow="COMPUTE RESOURCES"
        title="虚拟机"
        description="计算资源、运行状态和网络地址，一目了然。"
        action={
          <Button
            variant="contained"
            startIcon={<Plus size={18} />}
            onClick={() => navigate("create")}
          >
            创建虚拟机
          </Button>
        }
      />
      <LoadError error={error} />
      <div className="filter-bar">
        <TextField
          placeholder="搜索名称、区域或 IP"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <Search size={18} />
                </InputAdornment>
              ),
            },
          }}
        />
        <Chip label={`${data?.length ?? 0} 台虚拟机`} variant="outlined" />
        <IconButton aria-label="刷新本地列表" onClick={reload}>
          <RefreshCw size={18} />
        </IconButton>
      </div>
      {loading && <LinearProgress />}
      <TableContainer component={Paper} className="data-table">
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>虚拟机</TableCell>
              <TableCell>状态</TableCell>
              <TableCell>规格 / 区域</TableCell>
              <TableCell>公网地址</TableCell>
              <TableCell>归属账户</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {data
              ?.filter((vm) =>
                `${vm.name} ${vm.location} ${vm.publicIps.join(" ")}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((vm) => (
                <TableRow hover key={vm.id}>
                  <TableCell>
                    <Button
                      className="vm-name"
                      onClick={() => setDetails(vm)}
                      startIcon={<Server size={18} />}
                    >
                      {vm.name}
                    </Button>
                    <small className="table-sub">
                      {vm.os} · {vm.diskSize || "—"} GiB 系统盘
                    </small>
                  </TableCell>
                  <TableCell>
                    <Status value={vm.powerState} />
                  </TableCell>
                  <TableCell>
                    {vm.size.replace("Standard_", "")}
                    <small className="table-sub">{vm.location}</small>
                  </TableCell>
                  <TableCell>
                    <span className="mono">
                      {vm.publicIps.join("\n") || "无公网 IP"}
                    </span>
                  </TableCell>
                  <TableCell>{vm.accountLabel}</TableCell>
                  <TableCell align="right">
                    <TextField
                      select
                      size="small"
                      label="管理"
                      value=""
                      sx={{ width: 110 }}
                      onChange={(e) => {
                        setSelected(vm);
                        setAction(e.target.value);
                        setConfirmation("");
                        setSize(vm.size);
                        setDisk(vm.diskSize + 32);
                      }}
                    >
                      {Object.entries(actionNames).map(([value, label]) => (
                        <MenuItem
                          key={value}
                          value={value}
                          disabled={!session.writesEnabled}
                        >
                          {label}
                        </MenuItem>
                      ))}
                    </TextField>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
        {data?.length === 0 && (
          <Empty
            title="暂无已同步的虚拟机"
            description="进入云账户页面，点击同步资源，读取已有虚拟机。"
            action={
              <Button onClick={() => navigate("accounts")}>前往云账户</Button>
            }
          />
        )}
      </TableContainer>
      <p className="page-note">
        显示最近一次同步的缓存。云端状态变化后，请在账户页手动同步。
      </p>
      <ConfirmDialog
        open={!!selected}
        title={actionNames[action] ?? ""}
        description={descriptions[action] ?? ""}
        target={selected?.name ?? ""}
        value={confirmation}
        onChange={setConfirmation}
        onClose={() => setSelected(null)}
        disabled={!session.writesEnabled}
        onConfirm={async () => {
          try {
            await api(`/machines/${selected!.id}/action`, "POST", {
              action,
              confirmation,
              ...(action === "resize" ? { size } : {}),
              ...(action === "disk" ? { diskSize: disk } : {}),
            });
            setSelected(null);
            notify("操作已加入后台任务队列");
          } catch (e) {
            notify((e as Error).message);
          }
        }}
      >
        {action === "resize" && (
          <TextField
            label="新规格"
            value={size}
            onChange={(e) => setSize(e.target.value)}
            helperText="例如 Standard_B2s；可在创建页面查看可用规格"
          />
        )}
        {action === "disk" && (
          <TextField
            label="新容量（GiB）"
            type="number"
            value={disk}
            onChange={(e) => setDisk(Number(e.target.value))}
          />
        )}
      </ConfirmDialog>
      {details && (
        <MachineDetails vm={details} onClose={() => setDetails(null)} />
      )}
    </>
  );
}
function MachineDetails({
  vm,
  onClose,
}: {
  vm: VirtualMachine;
  onClose: () => void;
}) {
  const [metrics, setMetrics] = useState<MetricPoint[] | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="center"
        >
          {vm.name}
          <IconButton aria-label="关闭详情" onClick={onClose}>
            <X />
          </IconButton>
        </Stack>
      </DialogTitle>
      <DialogContent>
        <div className="details-grid">
          {[
            ["运行状态", stateLabel[vm.powerState] ?? vm.powerState],
            ["规格", vm.size],
            ["区域", vm.location],
            ["资源组", vm.resourceGroup],
            ["私网 IP", vm.privateIps.join(", ")],
            ["公网 IP", vm.publicIps.join(", ")],
            ["最近同步", date(vm.syncedAt)],
          ].map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <b>{value || "—"}</b>
            </div>
          ))}
        </div>
        <Divider sx={{ my: 3 }} />
        <div className="panel-heading">
          <h2>最近 24 小时 · CPU 使用率</h2>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                setMetrics(await api(`/machines/${vm.id}/metrics`));
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
            startIcon={<Activity size={16} />}
          >
            {busy ? "读取中…" : "加载监控"}
          </Button>
        </div>
        <LoadError error={error} />
        {metrics ? (
          <>
            <Suspense fallback={<LinearProgress />}>
              <MetricsChart metrics={metrics} />
            </Suspense>
            <p className="muted">
              入站{" "}
              {(
                metrics.reduce(
                  (sum, point) => sum + (point.networkIn ?? 0),
                  0,
                ) / 1e9
              ).toFixed(3)}{" "}
              GB · 出站{" "}
              {(
                metrics.reduce(
                  (sum, point) => sum + (point.networkOut ?? 0),
                  0,
                ) / 1e9
              ).toFixed(3)}{" "}
              GB。空值表示 Azure 未返回采样。
            </p>
          </>
        ) : (
          <Empty
            title="按需读取监控"
            description="点击加载监控读取一次，结果缓存 5 分钟。"
          />
        )}
        <Button
          component="a"
          href={`https://portal.azure.com/#resource${vm.resourceId}`}
          target="_blank"
          rel="noreferrer"
          endIcon={<ExternalLink size={15} />}
        >
          在 Azure Portal 中打开
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function CreatePage({ session, notify, navigate }: PageProps) {
  const { data: accounts } = useLoad(() => api<Account[]>("/accounts"), []);
  const [accountId, setAccountId] = useState(""),
    [skus, setSkus] = useState<Sku[]>([]),
    [locations, setLocations] = useState<Location[]>([]),
    [images, setImages] = useState<ImageOption[]>(fallbackImages),
    [locationsError, setLocationsError] = useState(""),
    [imagesError, setImagesError] = useState(""),
    [loadingLocations, setLoadingLocations] = useState(false),
    [loadingImages, setLoadingImages] = useState(false),
    [loadingSkus, setLoadingSkus] = useState(false),
    [error, setError] = useState("");
  const [form, setForm] = useState<CreateVm>({
    name: "",
    location: "",
    size: "Standard_B1s",
    image: fallbackImages[0],
    diskSize: 30,
    username: "azureuser",
    authentication: "ssh",
    sshKey: "",
    password: "",
    allowedSource: "",
    ipv6: false,
    customData: "",
    confirmation: "",
  });
  const busy = loadingLocations || loadingImages || loadingSkus;
  const field = <K extends keyof CreateVm>(key: K, value: CreateVm[K]) =>
    setForm((old) => ({ ...old, [key]: value }));
  const imageValue = (option: {
    publisher: string;
    offer: string;
    sku: string;
  }) => `${option.publisher}|${option.offer}|${option.sku}`;
  const windows = looksLikeWindows(form.image);
  useEffect(() => {
    if (!accountId && accounts?.length)
      setAccountId(
        accounts.find((account) => account.state === "Enabled")?.id ?? "",
      );
  }, [accounts]);
  // Regions come from the subscription itself instead of a hard-coded list.
  useEffect(() => {
    if (!accountId) return;
    let current = true;
    setLoadingLocations(true);
    setLocationsError("");
    setLocations([]);
    api<Location[]>(`/accounts/${accountId}/locations`)
      .then((list) => {
        if (!current) return;
        setLocations(list);
        if (!list.some((location) => location.name === form.location))
          field("location", list[0]?.name ?? "");
      })
      .catch((e) => current && setLocationsError((e as Error).message))
      .finally(() => current && setLoadingLocations(false));
    return () => {
      current = false;
    };
  }, [accountId]);
  // Images are discovered live per region (server caches them 24h).
  useEffect(() => {
    if (!accountId || !form.location) return;
    let current = true;
    setLoadingImages(true);
    setImagesError("");
    api<ImageOption[]>(
      `/accounts/${accountId}/images?region=${encodeURIComponent(form.location)}`,
    )
      .then((list) => {
        if (!current || !list.length) return;
        setImages(list);
        const keep = list.find(
          (option) => imageValue(option) === imageValue(form.image),
        );
        const chosen = keep ?? list[0];
        field("image", chosen);
        if (looksLikeWindows(chosen)) field("authentication", "password");
      })
      .catch((e) => current && setImagesError((e as Error).message))
      .finally(() => current && setLoadingImages(false));
    return () => {
      current = false;
    };
  }, [accountId, form.location]);
  // Switching region or account invalidates previously loaded sizes.
  useEffect(() => {
    setSkus([]);
  }, [accountId, form.location]);
  async function loadSkus() {
    setLoadingSkus(true);
    setError("");
    try {
      setSkus(
        await api(
          `/accounts/${accountId}/skus?region=${encodeURIComponent(form.location)}`,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingSkus(false);
    }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setLoadingSkus(true);
    try {
      await api(`/accounts/${accountId}/machines`, "POST", form);
      notify("创建任务已提交。请到任务中心查看进度。");
      navigate("tasks");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingSkus(false);
    }
  }
  return (
    <>
      <Heading
        eyebrow="NEW COMPUTE RESOURCE"
        title="创建虚拟机"
        description="选择配置，连接你的下一台云服务器。"
      />
      <form onSubmit={submit}>
        <LoadError error={error} />
        {!session.writesEnabled && (
          <Alert severity="info" sx={{ mb: 3 }}>
            当前为只读模式。可以准备配置、查询规格；创建需由管理员启用云端写操作。
          </Alert>
        )}
        <div className="create-layout">
          <div>
            <Panel title="01 · 基本信息">
              <div className="form-grid">
                <TextField
                  label="归属账户"
                  select
                  value={accountId}
                  onChange={(e) => {
                    setAccountId(e.target.value);
                    setSkus([]);
                  }}
                >
                  <MenuItem value="" disabled>
                    请选择账户
                  </MenuItem>
                  {accounts
                    ?.filter((account) => account.state === "Enabled")
                    .map((account) => (
                      <MenuItem key={account.id} value={account.id}>
                        {account.label}
                      </MenuItem>
                    ))}
                </TextField>
                <TextField
                  label="虚拟机名称"
                  required
                  value={form.name}
                  onChange={(e) => field("name", e.target.value)}
                  helperText="以字母开头，可使用字母、数字和连字符"
                />
                <TextField
                  select
                  label="区域"
                  required
                  value={form.location}
                  onChange={(e) => field("location", e.target.value)}
                  disabled={loadingLocations || !locations.length}
                  helperText={
                    locationsError ||
                    (loadingLocations
                      ? "正在从 Azure 读取可用区域…"
                      : "来自当前订阅的可用区域")
                  }
                >
                  <MenuItem value="" disabled>
                    {loadingLocations ? "读取中…" : "请选择区域"}
                  </MenuItem>
                  {locations.map((location) => (
                    <MenuItem key={location.name} value={location.name}>
                      {location.displayName} · {location.name}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  select
                  label="系统镜像"
                  value={imageValue(form.image)}
                  disabled={loadingImages || !images.length}
                  onChange={(e) => {
                    const option = images.find(
                      (item) => imageValue(item) === e.target.value,
                    );
                    if (!option) return;
                    field("image", option);
                    if (looksLikeWindows(option))
                      field("authentication", "password");
                  }}
                  helperText={
                    imagesError ||
                    (loadingImages
                      ? "正在从 Azure 读取该区域镜像…"
                      : "来自 Azure 的镜像目录，结果缓存 24 小时")
                  }
                >
                  {images.map((option) => (
                    <MenuItem
                      key={imageValue(option)}
                      value={imageValue(option)}
                    >
                      {option.label} · {option.osType}
                    </MenuItem>
                  ))}
                </TextField>
              </div>
            </Panel>
            <Panel
              title="02 · 计算与存储"
              action={
                <Button
                  disabled={!accountId || busy}
                  size="small"
                  onClick={loadSkus}
                  startIcon={<RefreshCw size={15} />}
                >
                  加载可用规格
                </Button>
              }
            >
              <div className="form-grid">
                {skus.length ? (
                  <TextField
                    label="虚拟机规格"
                    select
                    value={
                      skus.some(
                        (sku) =>
                          sku.name === form.size &&
                          !sku.restricted &&
                          sku.architecture.toLowerCase() !== "arm64",
                      )
                        ? form.size
                        : ""
                    }
                    onChange={(e) => field("size", e.target.value)}
                  >
                    {skus
                      .filter(
                        (sku) =>
                          !sku.restricted &&
                          sku.architecture.toLowerCase() !== "arm64",
                      )
                      .map((sku) => (
                        <MenuItem key={sku.name} value={sku.name}>
                          {sku.name.replace("Standard_", "")} · {sku.cpus} vCPU
                          / {sku.memory} GiB
                        </MenuItem>
                      ))}
                  </TextField>
                ) : (
                  <TextField
                    label="虚拟机规格"
                    value={form.size}
                    onChange={(e) => field("size", e.target.value)}
                    helperText="点击加载以查询该订阅的实时可用规格"
                  />
                )}
                <TextField
                  type="number"
                  label="系统盘大小（GiB）"
                  value={form.diskSize}
                  onChange={(e) => field("diskSize", Number(e.target.value))}
                  helperText="Standard SSD · 30–4095 GiB"
                />
              </div>
            </Panel>
            <Panel title="03 · 访问与网络">
              <div className="form-grid">
                <TextField
                  label="管理员用户名"
                  value={form.username}
                  required
                  onChange={(e) => field("username", e.target.value)}
                />
                <TextField
                  label="认证方式"
                  select
                  value={form.authentication}
                  onChange={(e) =>
                    field(
                      "authentication",
                      e.target.value as "ssh" | "password",
                    )
                  }
                >
                  <MenuItem value="ssh" disabled={windows}>
                    SSH 公钥
                  </MenuItem>
                  <MenuItem value="password">密码</MenuItem>
                </TextField>
                <div className="span-two">
                  {form.authentication === "ssh" ? (
                    <TextField
                      label="RSA SSH 公钥"
                      multiline
                      minRows={3}
                      required
                      value={form.sshKey}
                      onChange={(e) => field("sshKey", e.target.value)}
                      placeholder="ssh-rsa AAAA…"
                    />
                  ) : (
                    <TextField
                      label="管理员密码"
                      type="password"
                      required
                      value={form.password}
                      onChange={(e) => field("password", e.target.value)}
                      helperText="至少 12 位，包含大小写、数字、符号中的三类"
                    />
                  )}
                </div>
                <TextField
                  label="允许管理访问的来源 CIDR"
                  required
                  value={form.allowedSource}
                  onChange={(e) => field("allowedSource", e.target.value)}
                  placeholder="203.0.113.10/32"
                  helperText="仅开放 SSH 22 或 RDP 3389；0.0.0.0/0 代表所有 IPv4"
                />
                <TextField
                  label="网络协议"
                  select
                  value={String(form.ipv6)}
                  onChange={(e) => field("ipv6", e.target.value === "true")}
                >
                  <MenuItem value="false">IPv4</MenuItem>
                  <MenuItem value="true">IPv4 + IPv6</MenuItem>
                </TextField>
                <div className="span-two">
                  <TextField
                    label="cloud-init / 启动脚本（选填）"
                    multiline
                    minRows={3}
                    value={form.customData}
                    onChange={(e) => field("customData", e.target.value)}
                    disabled={windows}
                  />
                </div>
              </div>
            </Panel>
          </div>
          <aside>
            <Paper className="summary-card">
              <div className="summary-icon">
                <CloudCog size={30} />
              </div>
              <h2>部署摘要</h2>
              <div className="summary-row">
                <span>虚拟机</span>
                <b>{form.name || "未命名"}</b>
              </div>
              <div className="summary-row">
                <span>区域</span>
                <b>{form.location}</b>
              </div>
              <div className="summary-row">
                <span>规格</span>
                <b>{form.size.replace("Standard_", "")}</b>
              </div>
              <div className="summary-row">
                <span>系统镜像</span>
                <b>{form.image.sku}</b>
              </div>
              <div className="summary-row">
                <span>系统盘</span>
                <b>{form.diskSize} GiB SSD</b>
              </div>
              <div className="summary-row">
                <span>公网 IP</span>
                <b>Standard · 静态</b>
              </div>
              <Divider sx={{ my: 3 }} />
              <Alert severity="warning">
                将创建独立资源组及网络资源，可能产生 Azure
                费用。失败后的部分资源会保留以便排查。
              </Alert>
              <TextField
                sx={{ mt: 3 }}
                label="再次输入虚拟机名称确认"
                value={form.confirmation}
                onChange={(e) => field("confirmation", e.target.value)}
              />
              <Button
                fullWidth
                type="submit"
                variant="contained"
                disabled={
                  busy ||
                  !session.writesEnabled ||
                  !accountId ||
                  !form.name ||
                  form.confirmation !== form.name
                }
                sx={{ mt: 3 }}
                startIcon={
                  busy ? <CircularProgress size={16} /> : <Plus size={17} />
                }
              >
                {busy ? "处理中…" : "创建虚拟机"}
              </Button>
              <p className="page-note">部署进度将在任务中心持续更新。</p>
            </Paper>
          </aside>
        </div>
      </form>
    </>
  );
}

function ExplorePage({
  mode,
  notify,
  session,
}: PageProps & { mode: "resources" | "quota" }) {
  const { data: accounts } = useLoad(() => api<Account[]>("/accounts"), []);
  const [account, setAccount] = useState(""),
    [region, setRegion] = useState(""),
    [regions, setRegions] = useState<Location[]>([]),
    [data, setData] = useState<Json[] | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [group, setGroup] = useState(""),
    [items, setItems] = useState<Json[] | null>(null),
    [remove, setRemove] = useState(""),
    [confirmation, setConfirmation] = useState("");
  useEffect(() => {
    setData(null);
    setItems(null);
  }, [account, region, mode]);
  // Region list comes from the selected account.
  useEffect(() => {
    if (!account) return;
    let current = true;
    api<Location[]>(`/accounts/${account}/locations`)
      .then((list) => {
        if (!current) return;
        setRegions(list);
        if (!list.some((location) => location.name === region))
          setRegion(list[0]?.name ?? "");
      })
      .catch(() => current && setRegions([]));
    return () => {
      current = false;
    };
  }, [account]);
  async function load() {
    setBusy(true);
    setError("");
    try {
      setData(
        await api(
          `/accounts/${account}/${mode === "quota" ? `quotas?region=${encodeURIComponent(region)}` : "groups"}`,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Heading
        eyebrow={
          mode === "quota" ? "SUBSCRIPTION CAPACITY" : "RESOURCE EXPLORER"
        }
        title={mode === "quota" ? "订阅配额" : "资源浏览器"}
        description={
          mode === "quota"
            ? "按需查询区域配额，在部署之前了解可用容量。"
            : "浏览资源组与云端资源。仅在点击查询时访问 Azure。"
        }
      />
      <LoadError error={error} />
      <Paper className="query-panel">
        <TextField
          select
          label="选择账户"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
        >
          <MenuItem value="" disabled>
            请选择账户
          </MenuItem>
          {accounts?.map((item) => (
            <MenuItem key={item.id} value={item.id}>
              {item.label}
            </MenuItem>
          ))}
        </TextField>
        {mode === "quota" && (
          <TextField
            select
            label="区域"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            disabled={!regions.length}
          >
            {regions.map((location) => (
              <MenuItem key={location.name} value={location.name}>
                {location.displayName} · {location.name}
              </MenuItem>
            ))}
          </TextField>
        )}
        <Button
          variant="contained"
          disabled={!account || busy}
          onClick={load}
          startIcon={<Search size={17} />}
        >
          {busy ? "读取中…" : "查询"}
        </Button>
      </Paper>
      {busy && <LinearProgress />}
      <TableContainer component={Paper} className="data-table">
        <Table>
          <TableHead>
            <TableRow>
              {(mode === "quota"
                ? ["配额名称", "已使用", "上限", "使用比例"]
                : ["资源组", "区域", "状态", "操作"]
              ).map((label) => (
                <TableCell key={label}>{label}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {data?.map((item) => (
              <TableRow key={item.id ?? item.name}>
                <TableCell>
                  <b>{item.label ?? item.name}</b>
                  {item.label && (
                    <small className="table-sub">{item.name}</small>
                  )}
                </TableCell>
                <TableCell>
                  {mode === "quota" ? item.current : item.location}
                </TableCell>
                <TableCell>
                  {mode === "quota"
                    ? item.limit
                    : (item.properties?.provisioningState ?? "—")}
                </TableCell>
                <TableCell>
                  {mode === "quota" ? (
                    <LinearProgress
                      variant="determinate"
                      value={
                        item.limit
                          ? Math.min(100, (item.current / item.limit) * 100)
                          : 0
                      }
                      sx={{ borderRadius: 2, minWidth: 120 }}
                    />
                  ) : (
                    <Stack direction="row" spacing={1}>
                      <Button
                        size="small"
                        onClick={async () => {
                          try {
                            setGroup(item.name);
                            setItems(
                              await api(
                                `/accounts/${account}/resources?group=${encodeURIComponent(item.name)}`,
                              ),
                            );
                          } catch (e) {
                            notify((e as Error).message);
                          }
                        }}
                      >
                        查看资源
                      </Button>
                      <IconButton
                        aria-label="删除资源组"
                        disabled={!session.writesEnabled}
                        onClick={() => {
                          setRemove(item.name);
                          setConfirmation("");
                        }}
                      >
                        <Trash2 size={16} />
                      </IconButton>
                    </Stack>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!data && (
          <Empty
            title="选择账户，开始查询"
            description="结果按需读取，配额查询缓存 5 分钟。"
          />
        )}
        {data?.length === 0 && (
          <Empty title="未找到资源" description="当前查询没有返回记录。" />
        )}
      </TableContainer>
      <Dialog
        open={!!items}
        onClose={() => setItems(null)}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>{group} · 资源</DialogTitle>
        <DialogContent>
          {items?.map((item) => (
            <div className="resource-line" key={item.id}>
              <Folder size={20} />
              <div className="resource-line-main">
                <b>{item.name}</b>
                <span>{item.type}</span>
              </div>
              <Button
                component="a"
                href={`https://portal.azure.com/#resource${item.id}`}
                target="_blank"
                rel="noreferrer"
                endIcon={<ExternalLink size={14} />}
              >
                打开
              </Button>
            </div>
          ))}
          {items?.length === 0 && (
            <Empty title="空资源组" description="该资源组中没有资源。" />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setItems(null)}>关闭</Button>
        </DialogActions>
      </Dialog>
      <ConfirmDialog
        open={!!remove}
        title="删除资源组及其全部资源"
        description="此操作将永久删除该资源组及其中的虚拟机、磁盘、IP 等资源，无法撤销。"
        target={remove}
        value={confirmation}
        onChange={setConfirmation}
        onClose={() => setRemove("")}
        onConfirm={async () => {
          try {
            await api(`/accounts/${account}/groups`, "DELETE", {
              group: remove,
              confirmation,
            });
            setRemove("");
            notify("资源组删除任务已提交");
          } catch (e) {
            notify((e as Error).message);
          }
        }}
      />
    </>
  );
}

function TasksPage({ revision }: PageProps) {
  const { data, error, reload } = useLoad(
    () => api<Task[]>("/tasks"),
    [revision],
  );
  useEffect(() => {
    if (!data?.some((task) => ["queued", "running"].includes(task.status)))
      return;
    const timer = setInterval(reload, 5000);
    return () => clearInterval(timer);
  }, [data, reload]);
  return (
    <>
      <Heading
        eyebrow="OPERATIONS & HISTORY"
        title="任务中心"
        description="每一步都有记录。页面刷新后，后台任务仍会继续执行。"
        action={
          <Button startIcon={<RefreshCw size={16} />} onClick={reload}>
            刷新任务
          </Button>
        }
      />
      <LoadError error={error} />
      <Panel title="操作记录">
        {data?.length ? (
          data.map((task) => (
            <div className="task-row" key={task.id}>
              <div className={`task-symbol ${task.status}`}>
                {task.status === "succeeded" ? (
                  <CheckCheck size={20} />
                ) : task.status === "running" ? (
                  <CircularProgress size={20} />
                ) : (
                  <ListChecks size={20} />
                )}
              </div>
              <div className="task-main">
                <b>
                  {task.kind} <span className="muted">/ {task.target}</span>
                </b>
                <p>{task.progress}</p>
                {task.error && (
                  <Alert severity="error" sx={{ my: 1 }}>
                    {task.error}
                  </Alert>
                )}
                <small>{date(task.createdAt)}</small>
              </div>
              <Status
                value={task.status === "running" ? "runningTask" : task.status}
              />
            </div>
          ))
        ) : (
          <Empty
            title="暂无后台任务"
            description="同步、创建与管理操作将在这里显示。"
          />
        )}
      </Panel>
    </>
  );
}

function SettingsPage({ session, notify }: PageProps) {
  const { data: audit } = useLoad(() => api<Audit[]>("/audit"), []);
  const [current, setCurrent] = useState(""),
    [password, setPassword] = useState(""),
    [users, setUsers] = useState<User[]>([]),
    [open, setOpen] = useState(false),
    [email, setEmail] = useState(""),
    [newPassword, setNewPassword] = useState(""),
    [role, setRole] = useState("user"),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (session.user?.role === "admin")
      void api<User[]>("/users")
        .then(setUsers)
        .catch((e) => notify(e.message));
  }, []);
  return (
    <>
      <Heading
        eyebrow="WORKSPACE SETTINGS"
        title="工作空间设置"
        description="管理登录、安全模式和工作空间成员。"
      />
      <div className="settings-grid">
        <Panel title="登录与安全">
          <div className="settings-content">
            <div className="identity">
              <Avatar>{session.user?.email[0].toUpperCase()}</Avatar>
              <div>
                <b>{session.user?.email}</b>
                <p>{session.user?.role === "admin" ? "管理员" : "普通成员"}</p>
              </div>
            </div>
            <Alert
              severity={session.writesEnabled ? "warning" : "info"}
              sx={{ mb: 3 }}
            >
              {session.writesEnabled
                ? "云端写操作已启用。变更资源需输入名称确认。"
                : "只读模式已启用。云端写操作在服务端被阻止。"}
            </Alert>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  await api("/password", "PUT", { current, password });
                  location.reload();
                } catch (error) {
                  notify((error as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Stack spacing={2}>
                <TextField
                  label="当前密码"
                  type="password"
                  required
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                />
                <TextField
                  label="新密码（至少 12 位）"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <Button type="submit" variant="outlined" disabled={busy}>
                  修改密码并重新登录
                </Button>
              </Stack>
            </form>
          </div>
        </Panel>
        <Panel title="最近审计记录">
          <div className="audit-list">
            {audit?.map((item) => (
              <div className="audit-row" key={item.id}>
                <ShieldCheck size={17} />
                <div>
                  <b>{item.action}</b>
                  <span>{item.target}</span>
                  <small>{date(item.createdAt)}</small>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      {session.user?.role === "admin" && (
        <Panel
          title="工作空间成员"
          action={
            <Button
              onClick={() => setOpen(true)}
              startIcon={<Plus size={17} />}
            >
              添加成员
            </Button>
          }
        >
          {users.map((user) => (
            <div className="resource-line" key={user.id}>
              <Avatar sx={{ width: 34, height: 34 }}>
                {user.email[0].toUpperCase()}
              </Avatar>
              <div className="resource-line-main">
                <b>{user.email}</b>
              </div>
              <Chip
                size="small"
                label={user.role === "admin" ? "管理员" : "成员"}
              />
            </div>
          ))}
        </Panel>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>添加工作空间成员</DialogTitle>
        <DialogContent>
          <Stack spacing={3} sx={{ pt: 1 }}>
            <TextField
              label="邮箱"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <TextField
              label="初始密码（至少 12 位）"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <TextField
              select
              label="角色"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              <MenuItem value="user">普通成员</MenuItem>
              <MenuItem value="admin">管理员</MenuItem>
            </TextField>
            <Alert severity="info">
              成员只能访问自己接入的 Azure 账户和资源。
            </Alert>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>取消</Button>
          <Button
            variant="contained"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api("/users", "POST", {
                  email,
                  password: newPassword,
                  role,
                });
                setUsers(await api("/users"));
                setOpen(false);
                setNewPassword("");
                notify("成员已创建");
              } catch (e) {
                notify((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            创建成员
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

const nav = [
  { page: "overview", label: "概览", icon: LayoutDashboard },
  { page: "accounts", label: "云账户", icon: Cloud },
  { page: "machines", label: "虚拟机", icon: Server },
  { page: "resources", label: "资源浏览器", icon: Folder },
  { page: "quota", label: "订阅配额", icon: Gauge },
  { page: "tasks", label: "任务中心", icon: ListChecks },
  { page: "settings", label: "设置", icon: Settings },
] as const;
function App() {
  const [session, setSession] = useState<Session | null>(null),
    [ready, setReady] = useState(false),
    [startupError, setStartupError] = useState(""),
    [page, setPage] = useState<Page>(
      (location.hash.slice(1) || "overview") as Page,
    ),
    [mobile, setMobile] = useState(false),
    [toast, setToast] = useState(""),
    [revision, setRevision] = useState(0);
  const [dark, setDark] = useState(() => {
    try {
      return localStorage.getItem("azpanel-theme-v2") === "dark";
    } catch {
      return false;
    }
  });
  const theme = useMemo(() => makeTheme(dark), [dark]);
  const notify = useCallback((message: string) => setToast(message), []);
  const navigate = (next: Page) => {
    location.hash = next;
    setPage(next);
    setMobile(false);
    setRevision((value) => value + 1);
  };
  useEffect(() => {
    api<Session>("/session")
      .then((value) => {
        setSession(value);
        setCsrf(value.csrf);
      })
      .catch((e) => setStartupError(e.message))
      .finally(() => setReady(true));
    const listener = () =>
      setPage((location.hash.slice(1) || "overview") as Page);
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);
  const props = { navigate, notify, session: session!, revision };
  const navigation = (
    <div className="sidebar-inner">
      <div className="brand">
        <div className="brand-mark">
          <Cloud size={23} />
        </div>
        azpanel<span>2.0</span>
      </div>
      <div className="workspace-pill">
        <div className="workspace-avatar">A</div>
        <div>
          <b>我的工作空间</b>
          <small>Azure infrastructure</small>
        </div>
        <ChevronRight size={16} />
      </div>
      <div className="nav-label">WORKSPACE</div>
      <nav>
        {nav.map((item) => (
          <button
            key={item.page}
            className={`nav-item ${page === item.page || (page === "create" && item.page === "machines") ? "active" : ""}`}
            onClick={() => navigate(item.page)}
          >
            <item.icon size={20} strokeWidth={1.8} />
            <span>{item.label}</span>
            {item.page === "tasks" && <span className="nav-mini-dot" />}
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-tip">
          <ShieldCheck size={23} />
          <b>{session?.writesEnabled ? "操作由你掌控" : "安心的只读模式"}</b>
          <p>
            {session?.writesEnabled
              ? "所有资源变更都将记录在任务中心。"
              : "浏览与同步资源，不改动云端配置。"}
          </p>
          <button onClick={() => navigate("settings")}>
            工作空间设置 <ArrowUpRight size={15} />
          </button>
        </div>
        <a
          className="source-link"
          href="https://github.com/zkysimon/azpanel"
          target="_blank"
          rel="noreferrer"
        >
          开源，让管理更透明 <ExternalLink size={13} />
        </a>
      </div>
    </div>
  );
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <div data-theme={dark ? "dark" : "light"}>
        {!ready ? (
          <div className="splash">
            <Cloud size={48} />
            <CircularProgress size={24} />
          </div>
        ) : startupError ? (
          <div className="splash">
            <Alert severity="error">无法连接服务：{startupError}</Alert>
            <Button onClick={() => location.reload()}>重试</Button>
          </div>
        ) : !session?.user ? (
          <Login onLogin={setSession} />
        ) : (
          <div className="app-layout">
            <aside className="sidebar">{navigation}</aside>
            <Drawer
              open={mobile}
              onClose={() => setMobile(false)}
              slotProps={{ paper: { sx: { width: 268 } } }}
            >
              {navigation}
            </Drawer>
            <div className="workspace">
              <header className="topbar">
                <div className="breadcrumbs">
                  <IconButton
                    className="mobile-menu"
                    aria-label="打开导航"
                    onClick={() => setMobile(true)}
                  >
                    <Menu size={21} />
                  </IconButton>
                  <span>工作空间</span>
                  <ChevronRight size={15} />
                  <b>
                    {page === "create"
                      ? "创建虚拟机"
                      : (nav.find((item) => item.page === page)?.label ??
                        "概览")}
                  </b>
                </div>
                <div className="topbar-actions">
                  <span className="mode-badge">
                    <span />
                    {session.writesEnabled ? "云端管理已启用" : "只读模式"}
                  </span>
                  <Tooltip title={dark ? "切换浅色模式" : "切换深色模式"}>
                    <IconButton
                      aria-label="切换主题"
                      onClick={() =>
                        setDark((old) => {
                          try {
                            localStorage.setItem(
                              "azpanel-theme-v2",
                              !old ? "dark" : "light",
                            );
                          } catch {}
                          return !old;
                        })
                      }
                    >
                      {dark ? <Sun size={19} /> : <Moon size={19} />}
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="任务中心">
                    <IconButton
                      aria-label="任务中心"
                      onClick={() => navigate("tasks")}
                    >
                      <Bell size={19} />
                    </IconButton>
                  </Tooltip>
                  <Divider orientation="vertical" flexItem sx={{ mx: 1 }} />
                  <Tooltip title={session.user.email}>
                    <Avatar
                      className="user-avatar"
                      onClick={() => navigate("settings")}
                    >
                      {session.user.email[0].toUpperCase()}
                    </Avatar>
                  </Tooltip>
                  <Tooltip title="退出登录">
                    <IconButton
                      aria-label="退出登录"
                      onClick={async () => {
                        try {
                          await api("/logout", "POST");
                          setSession(null);
                        } catch (e) {
                          notify((e as Error).message);
                        }
                      }}
                    >
                      <LogOut size={17} />
                    </IconButton>
                  </Tooltip>
                </div>
              </header>
              <main className="main-content" key={page}>
                {page === "accounts" ? (
                  <AccountsPage {...props} />
                ) : page === "machines" ? (
                  <MachinesPage {...props} />
                ) : page === "create" ? (
                  <CreatePage {...props} />
                ) : page === "resources" || page === "quota" ? (
                  <ExplorePage {...props} mode={page} />
                ) : page === "tasks" ? (
                  <TasksPage {...props} />
                ) : page === "settings" ? (
                  <SettingsPage {...props} />
                ) : (
                  <OverviewPage {...props} />
                )}
              </main>
              <footer className="app-footer">
                <span>azpanel · 为简单的云管理而构建</span>
                <span>
                  本地加密存储 <ShieldCheck size={13} />
                </span>
              </footer>
            </div>
          </div>
        )}
      </div>
      <Snackbar
        open={!!toast}
        autoHideDuration={6000}
        onClose={() => setToast("")}
        message={toast}
        action={
          <IconButton
            color="inherit"
            aria-label="关闭提示"
            onClick={() => setToast("")}
          >
            <X size={17} />
          </IconButton>
        }
      />
    </ThemeProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
