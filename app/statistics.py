from .models import MeshtasticPacket

class PacketStat:
    def __init__(self):
        self.sources = {}
        self.counter = 0

    def add_packet(self, packet: MeshtasticPacket):
        if self.sources.get(packet.id_):
            self.sources[packet.id_]['count'] += 1
            if packet.relay_node and hex(packet.relay_node) not in self.sources[packet.id_]['relays']:
                self.sources[packet.id_]['relays'].append(hex(packet.relay_node))
        else:
            self.sources[packet.id_] = {
                'count': 1,
                'app': packet.decoded_portnum,
                'relays': [hex(packet.relay_node)] if packet.relay_node else [],
                'responses': []
            }
        if self.sources.get(packet.decoded_requestid) and packet.id_ not in self.sources[packet.decoded_requestid]['responses']:
            self.sources[packet.decoded_requestid]['responses'].append(packet.id_)

        if self.counter < 20:
            self.counter += 1
        else:
            self.counter = 0
            import pprint
            pprint.pprint(self.sources, width=80, compact=True)

    def dump_stats(self):
        pass
