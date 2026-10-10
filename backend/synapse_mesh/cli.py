import argparse
import asyncio
from contextlib import aclosing
import json

from .runtime import Runtime
from .orchestrator import Orchestrator


async def execute(args):
    orchestrator = Orchestrator(Runtime(args.vault, args.base_model, args.device))
    async with aclosing(orchestrator.events(args.prompt, args.max_new_tokens,
                                           compare=not args.response_only)) as events:
        async for event in events:
            print(json.dumps(event), flush=True)


def main():
    parser = argparse.ArgumentParser(description="Classify → fuse real LoRA matrices → compare generation")
    parser.add_argument("prompt")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "mps", "cuda"])
    parser.add_argument("--vault")
    parser.add_argument("--base-model")
    parser.add_argument("--max-new-tokens", type=int, default=192)
    parser.add_argument("--response-only", action="store_true", help="Fuse and respond without baseline generation")
    args = parser.parse_args()
    if not args.prompt.strip() or not 16 <= args.max_new_tokens <= 512:
        parser.error("Use a nonempty prompt and between 16 and 512 new tokens")
    asyncio.run(execute(args))


if __name__ == "__main__":
    main()
