"""Cloud-Kernel RTT and read-only IOS XE telemetry, with simulated demo states."""
from dataclasses import asdict, dataclass, replace
from enum import StrEnum
import math
import os
from threading import RLock
import time
from urllib.parse import urlsplit

import httpx


class NetworkState(StrEnum):
    OPTIMAL = 'OPTIMAL'
    CONGESTED = 'CONGESTED'
    CRITICAL = 'CRITICAL'
    OFFLINE = 'OFFLINE'


@dataclass(frozen=True)
class NetworkSnapshot:
    state: NetworkState
    source: str
    revision: int
    sampled_at: float
    utilization: float | None = None
    latency_ms: float | None = None
    interfaces: tuple = ()
    detail: str = ''
    latency_kind: str = 'RESTCONF management response time'

    def to_dict(self):
        return {**asdict(self), 'network_cap': self.network_cap}

    @property
    def network_cap(self):
        return {NetworkState.OPTIMAL: 1.0, NetworkState.CONGESTED: .4,
                NetworkState.CRITICAL: .1, NetworkState.OFFLINE: .1}[self.state]


class CiscoSentinel:
    """Counter deltas measure traffic; HTTPS request time measures management RTT.

    IETF interface speed is bits/second, counters are octets. Use the busier
    direction on full-duplex links, not RX+TX divided by link capacity. Counter
    resets/discontinuities start a fresh sampling interval. The first sample
    conservatively uses CONGESTED until a rate can actually be measured.
    """
    def __init__(self, host=None, username=None, password=None, *, mock_mode=True,
                 verify_tls=True, interface_names=(), utilization_threshold=.7,
                 latency_threshold_ms=150, poll_interval=2, timeout=3,
                 restconf_path='/restconf/data/ietf-interfaces:interfaces-state',
                 transport=None, clock=time.monotonic, critical_utilization_threshold=.95,
                 critical_latency_threshold_ms=1000, cloud_kernel_url=None):
        if not 0 < utilization_threshold <= 1 or not all(math.isfinite(x) and x > 0 for x in (latency_threshold_ms, poll_interval, timeout)):
            raise ValueError('Telemetry thresholds, interval, and timeout must be finite and positive')
        if not utilization_threshold < critical_utilization_threshold <= 1 or not math.isfinite(critical_latency_threshold_ms) or critical_latency_threshold_ms <= latency_threshold_ms:
            raise ValueError('Critical thresholds must exceed the congestion thresholds')
        self.host = host.rstrip('/') if host else None
        self.cloud_kernel_url = cloud_kernel_url
        if cloud_kernel_url:
            parts = urlsplit(cloud_kernel_url)
            if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password or parts.fragment:
                raise ValueError('Cloud-Kernel probe must be an HTTP(S) URL without embedded credentials')
        if self.host:
            parts = urlsplit(self.host)
            if parts.scheme != 'https' or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment or parts.path:
                raise ValueError('Cisco host must be an HTTPS origin without embedded credentials')
        if not restconf_path.startswith('/restconf/data/'):
            raise ValueError('Use a RESTCONF data path')
        self.username, self.password = username, password
        self.mock_mode, self.verify_tls = mock_mode, verify_tls
        self.interface_names = set(interface_names)
        self.utilization_threshold, self.latency_threshold_ms = utilization_threshold, latency_threshold_ms
        self.critical_utilization_threshold = critical_utilization_threshold
        self.critical_latency_threshold_ms = critical_latency_threshold_ms
        self.poll_interval, self.timeout, self.restconf_path = poll_interval, timeout, restconf_path
        self.transport, self.clock = transport, clock
        self._lock = RLock()
        self._previous = {}
        self._last_poll = clock()
        source = 'mock' if mock_mode else 'cloud-rtt' if cloud_kernel_url else 'restconf'
        kind = 'Edge-to-Cloud-Kernel HTTP round-trip time' if cloud_kernel_url else 'RESTCONF management response time'
        self._snapshot = NetworkSnapshot(NetworkState.OFFLINE, source, 0, time.time(),
                                         detail='No telemetry sample yet', latency_kind=kind)
        if mock_mode:
            self.set_mock_state(NetworkState.OPTIMAL)

    @classmethod
    def from_env(cls):
        mode = os.getenv('CISCO_MODE', 'mock').lower()
        if mode not in ('mock', 'restconf', 'cloud'):
            raise ValueError('CISCO_MODE must be mock, restconf, or cloud')
        cloud_url = (os.getenv('SYNAPSE_CLOUD_KERNEL_HEALTH_URL') or os.getenv('SYNAPSE_CLOUD_KERNEL_URL')) if mode == 'cloud' else None
        if mode == 'cloud' and not cloud_url:
            raise ValueError('Cloud monitoring requires SYNAPSE_CLOUD_KERNEL_URL (a lightweight health endpoint)')
        if mode == 'cloud' and not os.getenv('SYNAPSE_CLOUD_KERNEL_HEALTH_URL'):
            parts = urlsplit(cloud_url)
            if not parts.path.endswith('/health'):
                cloud_url = f'{parts.scheme}://{parts.netloc}/health'
        return cls(os.getenv('CISCO_HOST'), os.getenv('CISCO_USERNAME'), os.getenv('CISCO_PASSWORD'),
                   mock_mode=mode == 'mock', verify_tls=os.getenv('CISCO_VERIFY_TLS', 'true').lower() != 'false',
                   interface_names=filter(None, os.getenv('CISCO_INTERFACES', '').split(',')),
                   utilization_threshold=float(os.getenv('CISCO_UTILIZATION_THRESHOLD', '.7')),
                   latency_threshold_ms=float(os.getenv('CISCO_LATENCY_THRESHOLD_MS', '150')),
                   poll_interval=float(os.getenv('CISCO_POLL_INTERVAL', '2')),
                   critical_utilization_threshold=float(os.getenv('CISCO_CRITICAL_UTILIZATION_THRESHOLD', '.95')),
                   critical_latency_threshold_ms=float(os.getenv('CISCO_CRITICAL_LATENCY_THRESHOLD_MS', '1000')),
                   restconf_path=os.getenv('CISCO_RESTCONF_PATH', '/restconf/data/ietf-interfaces:interfaces-state'),
                   cloud_kernel_url=cloud_url)

    def _publish(self, state, **metrics):
        revision = self._snapshot.revision + (state != self._snapshot.state)
        source = 'mock' if self.mock_mode else 'cloud-rtt' if self.cloud_kernel_url else 'restconf'
        if self.cloud_kernel_url and not self.mock_mode:
            metrics.setdefault('latency_kind', 'Edge-to-Cloud-Kernel HTTP round-trip time')
        self._snapshot = NetworkSnapshot(state, source, revision, time.time(), **metrics)
        self._last_poll = self.clock()
        return self._snapshot

    def set_mock_state(self, state):
        if not self.mock_mode:
            raise ValueError('Mock controls are disabled for live RESTCONF telemetry')
        state = NetworkState(state)
        with self._lock:
            utilization, latency = {NetworkState.OPTIMAL: (.08, 12), NetworkState.CONGESTED: (.93, 350), NetworkState.CRITICAL: (.99, 1200), NetworkState.OFFLINE: (None, None)}[state]
            return self._publish(state, utilization=utilization, latency_ms=latency,
                                 detail='Simulated network telemetry; no router traffic is changed')

    def snapshot(self):
        with self._lock:
            if not self.mock_mode and self._snapshot.state != NetworkState.OFFLINE and self.clock() - self._last_poll > max(self.poll_interval * 3, self.timeout * 2):
                self._snapshot = replace(self._snapshot, state=NetworkState.OFFLINE, revision=self._snapshot.revision + 1, detail='Telemetry sample is stale')
            return self._snapshot

    def poll(self):
        if self.mock_mode:
            return self.snapshot()
        if self.cloud_kernel_url:
            return self._poll_cloud()
        with self._lock:
            if not all((self.host, self.username, self.password)):
                return self._publish(NetworkState.OFFLINE, detail='Configure CISCO_HOST, CISCO_USERNAME, and CISCO_PASSWORD')
            try:
                started = self.clock()
                with httpx.Client(auth=(self.username, self.password), verify=self.verify_tls,
                                  timeout=self.timeout, transport=self.transport, trust_env=False) as client:
                    response = client.get(self.host + self.restconf_path, headers={'Accept': 'application/yang-data+json'})
                    response.raise_for_status()
                    payload = response.json()
                now = self.clock()
                latency = max(0, (now - started) * 1000)
                container = payload.get('ietf-interfaces:interfaces-state', {})
                entries = container.get('interface', [])
                if not isinstance(entries, list):
                    raise ValueError('Malformed interface list')
                samples, warmup, current = [], False, {}
                for row in entries:
                    name = row.get('name')
                    if not name or (self.interface_names and name not in self.interface_names):
                        continue
                    if str(row.get('oper-status', '')).split(':')[-1] != 'up':
                        continue
                    statistics = row.get('statistics', {})
                    speed = int(row.get('speed', 0))
                    if speed <= 0 or not all(key in statistics for key in ('in-octets', 'out-octets')):
                        continue
                    rx, tx = int(statistics['in-octets']), int(statistics['out-octets'])
                    if min(rx, tx) < 0:
                        raise ValueError('Negative traffic counter')
                    discontinuity = statistics.get('discontinuity-time')
                    current[name] = (now, rx, tx, discontinuity)
                    previous = self._previous.get(name)
                    rates = None
                    if previous and now > previous[0] and discontinuity == previous[3] and rx >= previous[1] and tx >= previous[2]:
                        rates = ((rx - previous[1]) * 8 / (now - previous[0]), (tx - previous[2]) * 8 / (now - previous[0]))
                    else:
                        warmup = True
                    samples.append({'name': name, 'speed_bps': speed, 'rx_bps': rates[0] if rates else None,
                                    'tx_bps': rates[1] if rates else None,
                                    'utilization': max(rates) / speed if rates else None})
                self._previous = current
                if not samples:
                    return self._publish(NetworkState.OFFLINE, latency_ms=latency, detail='No monitored up interface has usable bandwidth and traffic counters')
                utilization = max((row['utilization'] for row in samples if row['utilization'] is not None), default=None)
                congested = warmup or latency >= self.latency_threshold_ms or (utilization is not None and utilization >= self.utilization_threshold)
                critical = latency >= self.critical_latency_threshold_ms or (utilization is not None and utilization >= self.critical_utilization_threshold)
                return self._publish(NetworkState.CRITICAL if critical else NetworkState.CONGESTED if congested else NetworkState.OPTIMAL,
                                     utilization=utilization, latency_ms=latency, interfaces=tuple(samples),
                                     detail='Waiting for a second counter sample' if warmup else 'Measured interface counter rates and management response time')
            except httpx.HTTPStatusError as error:
                self._previous.clear()
                return self._publish(NetworkState.OFFLINE, detail=f'RESTCONF HTTP {error.response.status_code}')
            except (httpx.HTTPError, ValueError, TypeError, AttributeError, KeyError):
                self._previous.clear()
                return self._publish(NetworkState.OFFLINE, detail='RESTCONF transport failed or telemetry was invalid')

    def _poll_cloud(self):
        # Do not hold the snapshot lock across network I/O: inference and UI
        # readers must remain responsive while a probe waits or times out.
        try:
            started = self.clock()
            with httpx.Client(verify=self.verify_tls, timeout=self.timeout,
                              transport=self.transport, trust_env=False) as client:
                with client.stream('GET', self.cloud_kernel_url) as response:
                    response.raise_for_status()
                    # Measure through response headers, without downloading a
                    # large body. Use the Cloud-Kernel's lightweight health URL.
                    latency = max(0, (self.clock() - started) * 1000)
            state = (NetworkState.CRITICAL if latency >= self.critical_latency_threshold_ms else
                     NetworkState.CONGESTED if latency > self.latency_threshold_ms else NetworkState.OPTIMAL)
            with self._lock:
                return self._publish(state, latency_ms=latency, detail='Measured Cloud-Kernel health round trip')
        except (httpx.HTTPError, ValueError):
            with self._lock:
                return self._publish(NetworkState.OFFLINE, detail='Cloud-Kernel probe failed or timed out')
