// Pupsi Chess - full-screen chess.com web view with injected engine
import SwiftUI

struct ContentView: View {
    @State private var showInfo = false

    var body: some View {
        WebViewHost()
            .ignoresSafeArea()
            .overlay(alignment: .topTrailing) {
                Button {
                    showInfo = true
                } label: {
                    Image(systemName: "info.circle.fill")
                        .font(.system(size: 20))
                        .foregroundStyle(.white.opacity(0.75))
                        .padding(10)
                        .background(.black.opacity(0.45), in: Circle())
                }
                .padding(.top, 8)
                .padding(.trailing, 8)
            }
            .sheet(isPresented: $showInfo) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Pupsi v1").font(.title.bold())
                    Text("made by static").foregroundStyle(.secondary)
                    Divider()
                    Text("Tippe auf das Zahnrad auf der Chess.com-Seite, um das Menü zu öffnen. Dort kannst du Farben, Pfeil-Designs und Gambit-Modus einstellen.")
                    Text("Die Engine läuft komplett lokal im App-Bundle. Es werden keine Daten an externe Server gesendet.")
                    Spacer()
                }
                .padding()
                .presentationDetents([.medium])
            }
    }
}
