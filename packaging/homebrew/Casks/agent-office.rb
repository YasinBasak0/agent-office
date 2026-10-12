cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.8.3"
  sha256 arm:   "768fb33b1e0daec02deb67dc50aa30771b39884695abb3724ba57230b4736566",
         intel: "1863b6abc899dbc87579d069e8042a9515196257e0cbac4d5ec152df05d5ae65"

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
