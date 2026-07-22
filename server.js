import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import aiRoutes from "./routes/aiRoutes.js";

dotenv.config();

const app = express();

// Configure CORS with exposed headers for provider & cache tracking
app.use(cors({
  origin: "*",
  exposedHeaders: ["X-AI-Provider", "X-Provider-Used", "X-Cache-Hit", "x-ai-provider", "x-provider-used", "x-cache-hit"]
}));

// Express middleware to ensure Access-Control-Expose-Headers is set on every response
app.use((req, res, next) => {
  res.setHeader("Access-Control-Expose-Headers", "X-AI-Provider, X-Provider-Used, X-Cache-Hit, x-ai-provider, x-provider-used, x-cache-hit");
  next();
});

// Set body parser limits to handle large base64 image strings
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.use("/api/ai", aiRoutes);

// Simple healthcheck route
app.get("/", (req, res) => {
  res.send("OneAI Backend is running");
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});