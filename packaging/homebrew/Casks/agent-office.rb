cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.15.0"
  sha256 arm:   "4d95ab106a9147a185f150df190bf33bfd240748cf49c7eca252453bde9c6506",
         intel: "67a7c376c2b8cd1f14edc11e242ac1b0270b2aff33a12d0e6b9ae9d5df98a4c5"

  url "https://github.com/isisever/agent-office/releases/download/v#{version}/AgentOffice-#{version}-#{arch}.dmg"
  name "Agent Office"
  desc "Pixel-art office for Claude Code agents, with a terminal per project"
  homepage "https://github.com/isisever/agent-office"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: :monterey

  app "Agent Office.app"

  zap trash: [
    "~/.claude/agent-office",
    "~/Library/Application Support/Agent Office",
    "~/Library/Preferences/io.github.isisever.agentoffice.plist",
    "~/Library/Saved Application State/io.github.isisever.agentoffice.savedState",
  ]

  caveats <<~EOS
    Agent Office runs the Claude Code CLI; install it first if needed:
      https://code.claude.com

  EOS
end
