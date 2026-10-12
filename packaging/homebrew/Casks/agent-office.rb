cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.6.3"
  sha256 arm:   "85acb8e7512cb8f56bcecbe6b238f20482631c4d28ea3c9405cc6b3d4258d042",
         intel: "ab1826f63eabd3b627a1c4fa5b8bd6723d61f99107fea21b9840221164cc7fbe"

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
