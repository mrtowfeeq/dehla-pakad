import { useMemo } from "react";
import axios from "axios";
import { useAuth } from "@clerk/react";

export const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API = `${BACKEND_URL}/api`;
export const WS_URL = `${BACKEND_URL.replace(/^http/, "ws")}/api/ws`;

export function useApi() {
  const { getToken } = useAuth();
  return useMemo(() => {
    const inst = axios.create({ baseURL: API });
    inst.interceptors.request.use(async (cfg) => {
      const t = await getToken();
      if (t) cfg.headers.Authorization = `Bearer ${t}`;
      return cfg;
    });
    return inst;
  }, [getToken]);
}

export const errMsg = (e) => e?.response?.data?.detail?.toString?.() || e?.message || "Something went wrong";

export const SUIT_SYMBOL = { S: "♠", H: "♥", D: "♦", C: "♣" };
export const SUIT_NAME = { S: "Spades", H: "Hearts", D: "Diamonds", C: "Clubs" };
export const isRed = (s) => s === "H" || s === "D";
export const cardSuit = (c) => c.slice(-1);
export const cardRank = (c) => c.slice(0, -1);
export const TEAM_NAME = ["Team A", "Team B"];
export const VICTORY_LABEL = { normal: "Normal Win", koth: "Koth", grand_slam: "Grand Slam · 13 Mann" };
export const REASON_LABEL = {
  three_tens: "Captured three tens", koth_declined: "Koth declined — three tens", koth_fourth_ten: "Captured the fourth ten",
  automatic_koth: "Automatic Koth — 3rd & 4th ten in one trick", grand_slam: "Won all 13 tricks",
  grand_slam_failed: "Grand Slam attempt failed", equal_tens: "Tens split 2–2, won 7 tricks",
};
