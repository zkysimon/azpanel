import { createHash, randomUUID } from "node:crypto";
import type {
  Account,
  Credentials,
  IpReplacementOption,
  Json,
  VirtualMachine,
} from "../shared/types.js";
import { Azure } from "./azure.js";
import { AppError } from "./store.js";

const network = "2023-11-01";
const compute = "2024-07-01";
const same = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();
const canonical = (value: any): any =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const pick = (value: Json, keys: string[]): Json =>
  Object.fromEntries(
    keys
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
const ipSettings = (ip: Json) => ({
  location: ip.location,
  sku: ip.sku,
  zones: ip.zones,
  tags: ip.tags,
  properties: pick(ip.properties ?? {}, [
    "publicIPAddressVersion",
    "publicIPAllocationMethod",
    "idleTimeoutInMinutes",
    "dnsSettings",
    "publicIPPrefix",
    "ipTags",
    "ddosSettings",
    "deleteOption",
  ]),
});
/** Preserve writable NIC settings, never PUT expanded read-only subnet/NSG data. */
function nicBody(nic: Json, configuration: string, publicId: string): Json {
  const properties = pick(nic.properties, [
    "enableAcceleratedNetworking",
    "enableIPForwarding",
    "disableTcpStateTracking",
    "auxiliaryMode",
    "auxiliarySku",
    "nicType",
    "workloadType",
    "migrationPhase",
  ]);
  if (nic.properties.networkSecurityGroup)
    properties.networkSecurityGroup = {
      id: nic.properties.networkSecurityGroup.id,
    };
  if (nic.properties.dnsSettings)
    properties.dnsSettings = pick(nic.properties.dnsSettings, [
      "dnsServers",
      "internalDnsNameLabel",
    ]);
  properties.ipConfigurations = nic.properties.ipConfigurations.map(
    (config: Json) => {
      const value = pick(config.properties, [
        "primary",
        "privateIPAddress",
        "privateIPAddressVersion",
        "privateIPAllocationMethod",
        "privateIPAddressPrefixLength",
      ]);
      for (const key of ["subnet", "gatewayLoadBalancer"])
        if (config.properties[key])
          value[key] = { id: config.properties[key].id };
      for (const key of [
        "applicationSecurityGroups",
        "loadBalancerBackendAddressPools",
        "loadBalancerInboundNatRules",
        "applicationGatewayBackendAddressPools",
      ])
        if (config.properties[key])
          value[key] = config.properties[key].map((item: Json) => ({
            id: item.id,
          }));
      if (config.properties.publicIPAddress)
        value.publicIPAddress = {
          id:
            config.name === configuration
              ? publicId
              : config.properties.publicIPAddress.id,
          ...(config.properties.publicIPAddress.properties?.deleteOption
            ? {
                properties: {
                  deleteOption:
                    config.properties.publicIPAddress.properties.deleteOption,
                },
              }
            : {}),
        };
      return { name: config.name, properties: value };
    },
  );
  return { location: nic.location, tags: nic.tags, properties };
}

export class AzureIp {
  constructor(private azure: Azure) {}
  private validateId(
    id: string,
    account: Account,
    vm: VirtualMachine,
    type: string,
  ) {
    const root = `/subscriptions/${account.subscriptionId}/resourceGroups/${vm.resourceGroup}/providers/${type}/`;
    if (
      !id?.toLowerCase().startsWith(root.toLowerCase()) ||
      !/^[\w.()-]+$/.test(id.slice(root.length))
    )
      throw new AppError(
        422,
        "公网 IP 更换仅支持当前订阅、当前资源组内直接关联的网卡和公网 IP",
      );
  }
  private async get(credentials: Credentials, id: string) {
    return (
      await this.azure.request(
        credentials,
        "GET",
        `${id}?api-version=${network}`,
      )
    ).data;
  }
  private async targets(
    credentials: Credentials,
    account: Account,
    vm: VirtualMachine,
  ) {
    this.validateId(
      vm.resourceId,
      account,
      vm,
      "Microsoft.Compute/virtualMachines",
    );
    const { data: fresh } = await this.azure.request(
      credentials,
      "GET",
      `${vm.resourceId}?api-version=${compute}`,
    );
    const result: { option: IpReplacementOption; nic: Json; ip: Json }[] = [];
    for (const link of fresh.properties?.networkProfile?.networkInterfaces ??
      []) {
      this.validateId(
        link.id,
        account,
        vm,
        "Microsoft.Network/networkInterfaces",
      );
      const nic = await this.get(credentials, link.id);
      if (!same(nic.properties?.virtualMachine?.id, vm.resourceId))
        throw new AppError(409, "网卡关联的虚拟机已变化，请同步后重试");
      for (const config of nic.properties?.ipConfigurations ?? []) {
        const id = config.properties?.publicIPAddress?.id;
        if (!id) continue;
        this.validateId(id, account, vm, "Microsoft.Network/publicIPAddresses");
        const ip = await this.get(credentials, id);
        const version = ip.properties?.publicIPAddressVersion;
        if (!["IPv4", "IPv6"].includes(version))
          throw new AppError(502, "Azure 公网 IP 响应缺少地址版本");
        const configId = `${link.id}/ipConfigurations/${config.name}`;
        let reason: string | undefined;
        if (
          !nic.etag ||
          !ip.etag ||
          !config.name ||
          !nic.location ||
          !ip.location ||
          !same(ip.properties?.ipConfiguration?.id, configId)
        )
          reason = "网卡或公网 IP 元数据不完整/关联变化，无法安全更换";
        else if (
          nic.properties?.provisioningState !== "Succeeded" ||
          ip.properties?.provisioningState !== "Succeeded"
        )
          reason = "网卡或公网 IP 尚未完成上一项操作，请稍后刷新";
        else if (
          ip.sku?.name !== "Standard" ||
          (ip.sku?.tier && ip.sku.tier !== "Regional") ||
          ip.properties?.publicIPAllocationMethod !== "Static"
        )
          reason = "当前仅支持区域级 Standard 静态公网 IP";
        else if (
          ip.properties?.publicIPPrefix ||
          ip.properties?.dnsSettings?.domainNameLabel ||
          ip.properties?.dnsSettings?.reverseFqdn ||
          ip.properties?.dnsSettings?.fqdn ||
          ip.properties?.ipTags?.length ||
          ip.properties?.natGateway ||
          ip.properties?.linkedPublicIPAddress ||
          ip.properties?.servicePublicIPAddress ||
          ip.properties?.ddosSettings?.ddosProtectionPlan ||
          ip.properties?.ddosSettings?.protectionMode === "Enabled" ||
          ip.extendedLocation ||
          nic.extendedLocation ||
          nic.properties?.privateEndpoint ||
          nic.properties?.privateLinkService ||
          nic.properties?.tapConfigurations?.length ||
          nic.properties?.dscpConfiguration
        )
          reason =
            "存在 DNS 标签、IP 前缀、专用链路或其他特殊网络设置，请在 Azure Portal 更换";
        result.push({
          option: {
            id,
            version,
            address: ip.properties?.ipAddress ?? "尚未分配",
            nicName: nic.name ?? link.id.split("/").pop(),
            configuration: config.name,
            fingerprint: hash([
              vm.resourceId.toLowerCase(),
              link.id.toLowerCase(),
              nic,
              ip,
            ]),
            ...(reason ? { unavailableReason: reason } : {}),
          },
          nic: { ...nic, id: link.id },
          ip: { ...ip, id },
        });
      }
    }
    return result;
  }
  async options(
    credentials: Credentials,
    account: Account,
    vm: VirtualMachine,
  ) {
    return (await this.targets(credentials, account, vm)).map(
      (target) => target.option,
    );
  }
  private async target(
    credentials: Credentials,
    account: Account,
    vm: VirtualMachine,
    id: string,
    fingerprint: string,
  ) {
    const target = (await this.targets(credentials, account, vm)).find(
      (target) => same(target.option.id, id),
    );
    if (!target || target.option.fingerprint !== fingerprint)
      throw new AppError(409, "公网 IP 或网卡配置已变化，请重新读取并确认");
    if (target.option.unavailableReason)
      throw new AppError(422, target.option.unavailableReason);
    return target;
  }
  async replace(
    credentials: Credentials,
    account: Account,
    vm: VirtualMachine,
    input: { id: string; fingerprint: string; deleteOld: boolean },
    progress: (message: string) => void,
  ) {
    const original = await this.target(
      credentials,
      account,
      vm,
      input.id,
      input.fingerprint,
    );
    const { ip: old, option, nic } = original;
    const token = randomUUID();
    const name = `${vm.name}-ip${option.version === "IPv6" ? "6" : ""}-${token.slice(0, 8)}`;
    const newId = `${old.id.slice(0, old.id.lastIndexOf("/") + 1)}${name}`;
    let switchAttempted = false;
    let newAddress = "尚未读取";
    try {
      progress(`创建新的 ${option.version} 公网 IP：${name}，旧地址暂时保留`);
      await this.azure.operation(
        credentials,
        "PUT",
        `${newId}?api-version=${network}`,
        {
          location: old.location,
          sku: old.sku,
          ...(old.zones ? { zones: old.zones } : {}),
          tags: {
            ...old.tags,
            managedBy: "azpanel",
            azpanelVmId: vm.resourceId,
            azpanelIpReplacement: token,
          },
          properties: {
            ...pick(old.properties, [
              "idleTimeoutInMinutes",
              "ddosSettings",
              "deleteOption",
            ]),
            publicIPAllocationMethod: "Static",
            publicIPAddressVersion: option.version,
          },
        },
        progress,
        { "If-None-Match": "*" },
      );
      const allocated = await this.get(credentials, newId);
      newAddress = allocated.properties?.ipAddress;
      if (
        !newAddress ||
        allocated.properties?.provisioningState !== "Succeeded" ||
        allocated.properties?.ipConfiguration ||
        allocated.properties?.publicIPAddressVersion !== option.version
      )
        throw new AppError(502, "新公网 IP 尚未分配成功，未切换网卡");
      // Re-read after allocation to avoid overwriting changes made from Portal.
      const current = await this.target(
        credentials,
        account,
        vm,
        input.id,
        input.fingerprint,
      );
      progress(
        `切换 ${option.configuration} 到 ${newAddress}，现有连接可能断开`,
      );
      switchAttempted = true;
      await this.azure.operation(
        credentials,
        "PUT",
        `${nic.id}?api-version=${network}`,
        nicBody(current.nic, option.configuration, newId),
        progress,
        { "If-Match": current.nic.etag },
      );
      const verifiedNic = await this.get(credentials, nic.id);
      const verifiedIp = await this.get(credentials, newId);
      if (
        verifiedNic.properties?.provisioningState !== "Succeeded" ||
        !same(
          verifiedNic.properties?.ipConfigurations?.find(
            (config: Json) => config.name === option.configuration,
          )?.properties?.publicIPAddress?.id,
          newId,
        ) ||
        !same(
          verifiedIp.properties?.ipConfiguration?.id,
          `${nic.id}/ipConfigurations/${option.configuration}`,
        ) ||
        !verifiedIp.properties?.ipAddress
      )
        throw new AppError(
          502,
          "未能确认新 IP 已成功关联，已保留新旧资源，请刷新状态勿重复提交",
        );
      newAddress = verifiedIp.properties.ipAddress;
    } catch (error) {
      // A timeout may hide an accepted NIC write: never remove either IP after
      // attempting the switch. Before that, only delete our proven-unused new IP.
      let cleanup = "";
      if (!switchAttempted) {
        try {
          const unused = await this.get(credentials, newId);
          if (
            same(unused.tags?.azpanelVmId, vm.resourceId) &&
            unused.tags?.azpanelIpReplacement === token &&
            unused.etag &&
            unused.properties?.provisioningState === "Succeeded" &&
            !unused.properties?.ipConfiguration
          ) {
            await this.azure.operation(
              credentials,
              "DELETE",
              `${newId}?api-version=${network}`,
              undefined,
              progress,
              { "If-Match": unused.etag },
            );
            cleanup = "未使用的新公网 IP 已清理。";
          }
        } catch {
          /* Keep ambiguous resources, never retry a write blindly. */
        }
      }
      throw new AppError(
        error instanceof AppError ? error.status : 502,
        `${error instanceof AppError ? error.message : "更换公网 IP 失败"}。${switchAttempted ? "切换结果可能不确定，未自动删除新旧 IP。" : "旧 IP 未切换。"}${cleanup || `请检查新资源 ${name}，它可能已创建并产生费用。`}旧资源 ${old.name ?? old.id.split("/").pop()}；新地址 ${newAddress || "尚未读取"}。`,
      );
    }
    let message = `${option.version} 已更换：${option.address} → ${newAddress}。`;
    if (input.deleteOld) {
      try {
        progress("已确认新 IP 关联成功，检查并删除旧公网 IP");
        const detached = await this.get(credentials, old.id);
        if (
          detached.properties?.ipConfiguration ||
          !detached.etag ||
          hash(ipSettings(detached)) !== hash(ipSettings(old))
        )
          throw new AppError(409, "旧公网 IP 已被重新关联或配置变化");
        await this.azure.operation(
          credentials,
          "DELETE",
          `${old.id}?api-version=${network}`,
          undefined,
          progress,
          { "If-Match": detached.etag },
        );
        message += "旧公网 IP 已删除。";
      } catch {
        message += `新 IP 已生效，但旧资源 ${old.name ?? old.id.split("/").pop()} 清理未完成，请在资源浏览器核对；保留的 IPv4 可能继续收费。`;
      }
    } else
      message +=
        "按确认保留旧公网 IP；旧 IPv4 仍可能计费，可在资源浏览器清理。";
    return { oldAddress: option.address, newAddress, message };
  }
}
