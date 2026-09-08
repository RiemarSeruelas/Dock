import { BlockList, isIP } from 'node:net';
export const normalizeAddress = value => String(value || '').replace(/^::ffff:/, '');
export function inNetworks(ip, networks) {
  if (!isIP(normalizeAddress(ip))) return false;
  return String(networks || '').split(',').some(entry => {
    try {
      const [network, bits] = entry.trim().split('/');
      const family = isIP(network) === 6 ? 'ipv6' : 'ipv4';
      const list = new BlockList();
      list.addSubnet(network, Number(bits ?? (family === 'ipv6' ? 128 : 32)), family);
      return list.check(normalizeAddress(ip), isIP(normalizeAddress(ip)) === 6 ? 'ipv6' : 'ipv4');
    } catch { return false; }
  });
}
// Walk from the socket peer towards the client, stopping at the first address
// outside explicitly trusted proxies. A client-supplied prefix is never trusted.
export function clientAddress(request, trustedProxies = '') {
  let current = normalizeAddress(request.socket.remoteAddress);
  const forwarded = String(request.headers['x-forwarded-for'] || '').split(',').map(value=>normalizeAddress(value.trim()));
  while (inNetworks(current,trustedProxies) && forwarded.length) current = forwarded.pop();
  return isIP(current) ? current : '';
}
