# Run from the repository root with the xcodeproj Ruby gem installed.
require 'xcodeproj'
project = Xcodeproj::Project.new('ios/Asset.xcodeproj')
target = project.new_target(:application, 'Asset', :ios, '18.0')
group = project.main_group.new_group('Asset', 'Asset')
Dir['ios/Asset/*.swift'].sort.each { |path| target.source_build_phase.add_file_reference(group.new_file(File.basename(path))) }
resources = group.new_group('Resources', 'Resources')
target.resources_build_phase.add_file_reference(resources.new_file('CalculationEngine.js'))
['Lato-Regular.ttf','Lato-Medium.ttf','OFL.txt'].each { |name| target.resources_build_phase.add_file_reference(resources.new_file('../../../public/fonts/'+name)) }
target.resources_build_phase.add_file_reference(resources.new_file('../../../public/third-party-notices.txt'))
group.new_file('Info.plist')
target.resources_build_phase.add_file_reference(group.new_file('Assets.xcassets'))
package = project.new(Xcodeproj::Project::Object::XCRemoteSwiftPackageReference)
package.repositoryURL = 'https://github.com/plaid/plaid-link-ios-spm.git'
package.requirement = {'kind'=>'exactVersion', 'version'=>'7.2.2'}
project.root_object.package_references << package
product = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
product.package = package
product.product_name = 'LinkKit'
target.package_product_dependencies << product
build_file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
build_file.product_ref = product
target.frameworks_build_phase.files << build_file
target.build_configurations.each do |config|
  config.build_settings.merge!({
    'PRODUCT_BUNDLE_IDENTIFIER'=>'org.gtfol.asset', 'SWIFT_VERSION'=>'5.0',
    'INFOPLIST_FILE'=>'Asset/Info.plist', 'GENERATE_INFOPLIST_FILE'=>'NO',
    'MARKETING_VERSION'=>'0.1.0', 'CURRENT_PROJECT_VERSION'=>'1',
    'TARGETED_DEVICE_FAMILY'=>'1,2', 'CODE_SIGN_STYLE'=>'Automatic',
    'ENABLE_USER_SCRIPT_SANDBOXING'=>'YES',
    'ASSETCATALOG_COMPILER_APPICON_NAME'=>'AppIcon'
  })
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(target)
scheme.set_launch_target(target)
scheme.save_as('ios/Asset.xcodeproj', 'Asset', true)
