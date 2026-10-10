"""Local Sifter and remote Cloud-Kernel streaming CLI."""
import argparse
import asyncio
from contextlib import aclosing
import json

from .orchestrator import Orchestrator


async def execute(args):
    orchestrator = Orchestrator(endpoint=args.cloud_url)
    try:
        async with aclosing(orchestrator.events(args.prompt, args.max_new_tokens,
                args.weights, args.experts, compare=not args.response_only)) as events:
            async for event in events:
                print(json.dumps(event, allow_nan=False), flush=True)
    finally:
        await orchestrator.aclose()


def main():
    parser = argparse.ArgumentParser(description='Local Sifter -> Cloud-Kernel -> streamed tokens')
    parser.add_argument('prompt')
    parser.add_argument('--cloud-url', help='Cloud-Kernel endpoint; defaults to SYNAPSE_CLOUD_KERNEL_URL')
    parser.add_argument('--experts', nargs='+', default=['coding', 'medical', 'legal'])
    parser.add_argument('--weights', type=json.loads, help='Optional JSON object with manual coefficients')
    parser.add_argument('--max-new-tokens', type=int, default=192)
    parser.add_argument('--response-only', action='store_true')
    args = parser.parse_args()
    if not args.prompt.strip() or not 16 <= args.max_new_tokens <= 512:
        parser.error('Use a nonempty prompt and between 16 and 512 new tokens')
    asyncio.run(execute(args))


if __name__ == '__main__':
    main()
