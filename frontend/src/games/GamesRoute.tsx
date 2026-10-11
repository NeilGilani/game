/** /games, /games/tictactoe, /games/connect4 and /games/chess. */
import { ChessGame } from "./ChessGame";
import { ConnectFour } from "./ConnectFour";
import { GamesHub } from "./GamesHub";
import { TicTacToe } from "./TicTacToe";

export function GamesRoute({ segments }: { segments: string[] }) {
  const [game] = segments;
  if (game === "tictactoe") return <TicTacToe />;
  if (game === "chess") return <ChessGame />;
  if (game === "connect4") return <ConnectFour />;
  return <GamesHub />;
}
